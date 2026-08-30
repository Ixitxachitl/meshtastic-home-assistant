// Home Assistant bootstrap for the bundled Meshtastic web client.
//
// Home Assistant redirects to index.html?path=/meshtastic/web/<config_entry_id>.
// The stock client has no idea what that means, so before the app starts we seed
// its saved-connection store (idb-keyval "keyval-store" / "meshtastic-device-store")
// with an HTTP connection pointing at that path. Without this the client loads
// with no connection configured and never reaches the gateway node.
//
// scripts/deploy_web injects this into the built index.html, replacing the
// module script tag vite emits, and substitutes __APP_MODULE_SRC__ with the
// hashed bundle name. Keep it dependency-free, pre-module, and ES5.

(function () {
    var APP_MODULE_SRC = "__APP_MODULE_SRC__";
    var appLoaded = false;

    function loadApp() {
        if (appLoaded) {
            return;
        }
        appLoaded = true;
        var script = document.createElement("script");
        script.type = "module";
        script.crossOrigin = "";
        script.src = APP_MODULE_SRC;
        document.head.appendChild(script);
    }

    // The router is mounted with the deployment base as its basepath, so the
    // document has to sit at that base for the index route to match. Home
    // Assistant redirects to <base>index.html, which resolves to no route at
    // all, and the not-found page appears the moment a device connects and the
    // app switches from the connection screen to route-driven rendering.
    function normalisePathnameToBase() {
        var base = APP_MODULE_SRC.slice(0, APP_MODULE_SRC.lastIndexOf("/") + 1);
        if (window.location.pathname !== base + "index.html") {
            return;
        }
        history.replaceState(null, "", base + window.location.search + window.location.hash);
    }

    function removePathQueryParam() {
        var params = new URLSearchParams(window.location.search);
        if (!params.has("path")) {
            return;
        }
        params.delete("path");
        var nextQuery = params.toString();
        var nextUrl = window.location.pathname + (nextQuery ? "?" + nextQuery : "") + window.location.hash;
        history.replaceState(null, "", nextUrl);
    }

    function seedConnectionFromPath() {
        var rawPath = new URLSearchParams(window.location.search).get("path");
        if (!rawPath) {
            return Promise.resolve();
        }

        var seedUrl;
        try {
            seedUrl = new URL(rawPath, window.location.origin).toString();
        } catch (_err) {
            return Promise.resolve();
        }

        var STORE_DB = "keyval-store";
        var STORE_NAME = "keyval";
        var STORE_KEY = "meshtastic-device-store";
        var VERSION = 0;

        function openDb() {
            return new Promise(function (resolve, reject) {
                var req = indexedDB.open(STORE_DB);
                req.onerror = function () {
                    reject(req.error);
                };
                req.onsuccess = function () {
                    resolve(req.result);
                };
                req.onupgradeneeded = function () {
                    var db = req.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
            });
        }

        function txGet(store, key) {
            return new Promise(function (resolve, reject) {
                var req = store.get(key);
                req.onerror = function () {
                    reject(req.error);
                };
                req.onsuccess = function () {
                    resolve(req.result);
                };
            });
        }

        function txPut(store, value, key) {
            return new Promise(function (resolve, reject) {
                var req = store.put(value, key);
                req.onerror = function () {
                    reject(req.error);
                };
                req.onsuccess = function () {
                    resolve(undefined);
                };
            });
        }

        function txDone(tx) {
            return new Promise(function (resolve, reject) {
                tx.oncomplete = function () {
                    resolve(undefined);
                };
                tx.onerror = function () {
                    reject(tx.error);
                };
                tx.onabort = function () {
                    reject(tx.error);
                };
            });
        }

        function buildSeedConnection(isDefault) {
            var now = Date.now();
            return {
                id: now,
                type: "http",
                name: "Home Assistant Gateway",
                createdAt: now,
                status: "disconnected",
                isDefault: isDefault,
                url: seedUrl,
            };
        }

        return openDb().then(function (db) {
            var tx = db.transaction(STORE_NAME, "readwrite");
            var store = tx.objectStore(STORE_NAME);

            return txGet(store, STORE_KEY)
                .then(function (raw) {
                    var parsed = null;
                    if (typeof raw === "string") {
                        try {
                            parsed = JSON.parse(raw);
                        } catch (_err) {
                            parsed = null;
                        }
                    }

                    var existingState = parsed && typeof parsed === "object" ? parsed.state : null;
                    var existingConnections =
                        existingState && Array.isArray(existingState.savedConnections)
                            ? existingState.savedConnections
                            : [];

                    var hasSeed = existingConnections.some(function (c) {
                        return c && c.type === "http" && c.url === seedUrl;
                    });
                    if (hasSeed) {
                        return;
                    }

                    var hasDefault = existingConnections.some(function (c) {
                        return c && c.type === "http" && c.isDefault === true;
                    });

                    var nextState = {
                        devices:
                            existingState && existingState.devices
                                ? existingState.devices
                                : { __datatype: "Map", value: [] },
                        savedConnections: existingConnections.concat([buildSeedConnection(!hasDefault)]),
                    };

                    var nextPayload = {
                        state: nextState,
                        version: VERSION,
                    };

                    return txPut(store, JSON.stringify(nextPayload), STORE_KEY);
                })
                .then(function () {
                    return txDone(tx);
                });
        });
    }

    var startupWatchdog = setTimeout(function () {
        loadApp();
    }, 1200);

    seedConnectionFromPath()
        .catch(function (_err) {
            // Best effort only; never block app startup.
        })
        .finally(function () {
            clearTimeout(startupWatchdog);
            removePathQueryParam();
            normalisePathnameToBase();
            loadApp();
        });
})();
