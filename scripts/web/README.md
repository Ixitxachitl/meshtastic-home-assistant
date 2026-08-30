# Bundling the Meshtastic web client

The client upstream publishes assumes it is served from the root of a device's
own web server. Home Assistant serves it from `/meshtastic/web/`, and each
gateway's API from `/meshtastic/web/<config entry id>/`. Every difference below
exists to bridge that gap.

`scripts/deploy_web` applies all of it at build time. Nothing here should ever
be hand-edited into the built output in `meshtastic_web/static/`: that
directory is wiped and regenerated on every deploy, and edits made there are
silently destroyed by the next upgrade. That has happened, and cost several
rounds of rediscovery, which is why this file exists.

## Why upstream needs none of this

The integration redirects to `index.html?path=/meshtastic/web/<config entry id>`.

Clients up to 2.6.x read that `path` parameter themselves
(`URLSearchParams(location.search).get("path") || "/meshtastic/web"`) and had no
router, rendering from state instead. So upstream can and does ship stock build
output. Support for `?path=` was dropped in 2.7.0, when the client moved to a
persisted saved-connections store and picked up TanStack Router.

## The deltas

Vite's `--base` handles every asset reference vite itself emits. It does not
reach anything below.

**Runtime asset paths** — built from string literals vite cannot see, so they
resolve against the server root: device images (`DeviceImage.tsx`), the i18n
load path (`i18n-config.ts`), the error page image (`ErrorPage.tsx`) and the
sidebar logo (`Sidebar.tsx`). All rewritten to derive from
`import.meta.env.BASE_URL`, which stays correct for any base including
upstream's own `/`.

To find these after an upgrade, grep the source for root-absolute references —
both attributes and bare file literals, not just asset directories:

    grep -rnE '(src|href)=[{"`]*"?/[a-zA-Z]' apps/web/src packages/*/src
    grep -rnoE '"/[a-zA-Z0-9._-]+\.(svg|png|ico|json|webmanifest)"' apps/web/src

**Which gateway to talk to** — `ha-bootstrap.js` seeds the address from the
`?path=` parameter into the saved-connections store (idb-keyval `keyval-store`,
key `meshtastic-device-store`) before the app boots, so it appears in the
connection list to be selected. Seeding before boot also sidesteps the store's
asynchronous rehydration. Seeding alone does not connect: `activeConnectionId`
is not persisted and starts null, and `isDefault` only drives sort order and a
badge. Connecting is left to the user, deliberately.

**Transport target** — `TransportHTTP.create()` takes an authority, not a URL,
and appends `/api/v1/...` to it. Passing `url.host` discards the gateway path
and sends every API call to the server root. Carry `url.pathname` through.

**Reachability probe** — `openHttp` and `probeConnection` probe the connection
URL, which here is an API base rather than a document; the integration maps it
to a static file lookup that always misses. Probe `hotspot-detect.html`
instead, which both the integration and Meshtastic firmware serve as a liveness
check. (The v2.7.1 build did not need this and passed the probe against the
bare URL under Home Assistant 2024.11; newer aiohttp appears to serve that miss
differently.)

**Router basepath** — the router is created without one and matches against the
full URL path, so nothing matches under a subdirectory and the not-found page
appears once a device connects and `App` switches to `<Outlet />`. The
bootstrap also rewrites `<base>index.html` to `<base>` so the index route
resolves. Note the v2.7.1 build carried no basepath and worked, so if routing
misbehaves after an upgrade this is the first thing to try removing.

## Known limitations

- **OPFS persistence needs cross-origin isolation.** SQLite stores
  `meshtastic.db` in the origin private file system, which needs
  SharedArrayBuffer, which needs the document isolated. The integration sends
  `COOP: same-origin` and `COEP: credentialless` on the document
  (`MeshtasticWebConfigEntryView`) to provide it. `credentialless` rather than
  `require-corp` because `Map.tsx` fetches its style from a third party that
  sends no CORP header; this matches upstream's own dev server. Safari does
  not implement `credentialless`, so it is not isolated there and persistence
  falls back to in-memory, as before.
- **Deep links do not survive a reload.** Once in, the URL becomes something
  like `/meshtastic/web/messages/broadcast/0`; reloading requests a
  multi-segment path the integration does not serve. Re-enter through the
  gateway link. Fixing this needs a catch-all route in
  `meshtastic_web/__init__.py` serving `index.html` for unmatched sub-paths.
- Upstream's `index.html` references `icon.svg` and `logo_black.svg`, which its
  own build does not emit. `deploy_web` drops those link tags and reports it.
- **`core.ignorecase`.** The build emits `logo.svg` lowercase. If git is
  configured to assume a case-insensitive filesystem it will not notice a
  casing change, and a capitalised name can end up committed and 404 for
  everyone on a case-sensitive filesystem. `git config core.ignorecase false`
  in this repo.

## Upgrading

Bump `WEB_VERSION` in `scripts/deploy_web` and run it. Every patch asserts on
the text it expects and the script aborts if upstream changed it, so a failure
means reading the new source rather than a silently broken bundle. Re-check
`apps/web/src/core/stores/deviceStore/` on each upgrade: `ha-bootstrap.js`
writes that store's persisted shape directly, and a schema change there would
seed a record the app ignores, which no build-time check can catch.
