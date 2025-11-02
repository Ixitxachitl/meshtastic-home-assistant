# Meshtastic Home Assistant Integration - AI Agent Instructions

## Project Overview
This is a Home Assistant custom integration for Meshtastic mesh radios. It acts as a gateway/bridge between Home Assistant and Meshtastic devices, supporting TCP, Serial, and Bluetooth connections with optional MQTT proxy capabilities.

## Architecture

### Core Components
- **`api.py`**: `MeshtasticApiClient` - Main interface wrapping the async Meshtastic connection (`aiomeshtastic`). Handles connection lifecycle, events, and protocol buffer message routing.
- **`coordinator.py`**: `MeshtasticDataUpdateCoordinator` - HA coordinator pattern for node state updates. Uses event-driven updates (not traditional polling) via `@meshtastic_api_event_callback` decorator.
- **`config_flow.py`**: Multi-step configuration UI for connection setup (TCP/Serial/Bluetooth), node filtering, notification platform options, and TCP proxy settings.
- **`aiomeshtastic/`**: Custom async library for Meshtastic protocol - NOT an external dependency. Contains connection transports (`tcp.py`, `serial.py`, `bluetooth.py`), protobuf definitions, and the `MeshInterface` abstraction.

### Key Patterns

#### Connection Management
Connections are managed via context managers. The integration supports:
```python
# TCP, Serial, and Bluetooth are conditionally imported
from .aiomeshtastic import TcpConnection, SerialConnection, BluetoothConnection
```
Connection type is stored in config as `CONF_CONNECTION_TYPE` and mapped to appropriate transport class.

#### Event-Driven Architecture
State updates flow through HA event bus rather than polling:
- `EVENT_MESHTASTIC_API_NODE_UPDATED` - Node state changes
- `EVENT_MESHTASTIC_API_TELEMETRY` - Device metrics
- `EVENT_MESHTASTIC_API_POSITION` - Location updates
- `meshtastic_api_text_message` - Message events (for automations)

Events include `config_entry_id` for multi-gateway support.

#### Node Filtering
Users select which nodes to import via `CONF_OPTION_FILTER_NODES`. Helper `get_nodes()` in `helpers.py` filters coordinator data accordingly. Only filtered nodes create HA entities.

### Special Features

#### TCP Proxy (`meshtastic_tcp/`)
Allows multiple simultaneous connections to devices that normally accept only one. The integration acts as a proxy server forwarding packets between clients and the actual device.

#### Web Client Integration (`meshtastic_web/`, `ha_frontend/`)
Bundles Meshtastic web client with proxy API (`frontend.py`). Creates HA sidebar panel for direct device interaction. Uses `StaticPathConfig` to serve web assets.

#### Notification Platform
New entity-based notification system (not legacy service). Creates `notify.mesh_*` entities for channels and selected nodes. See `notify.py` for entity creation.

## Development Workflow

### Running Locally
```bash
scripts/develop  # Starts HA with integration loaded
```
Sets `PYTHONPATH` to include `custom_components/` so imports work. HA runs from `config/` directory.

### Code Style
```bash
scripts/lint  # Runs ruff format + check --fix
```
Project uses Ruff for formatting and linting (not black/pylint).

### Protobuf Generation
```bash
scripts/generate_protobufs  # Regenerates protobuf Python files
```
Pulls from `protobufs/` directory, modifies package names to `meshtastic.aiomeshtastic.protobuf`, outputs to `aiomeshtastic/protobuf/`. Required when Meshtastic protocol updates.

## Critical Implementation Details

### Connection Initialization Sequence
1. `api.py` creates connection transport based on config type
2. Wraps in `MeshtasticApiClient` context manager
3. `async_connect()` establishes connection and requests node database
4. `config_complete_id` packet signals initialization done
5. Coordinator populated, entities created

### Message Handling
Messages use protobuf `mesh_pb2.FromRadio`/`ToRadio`. The `api.py` client subscribes to specific portnums:
- `TEXT_MESSAGE_APP` → fires HA events for automations
- `TELEMETRY_APP` → updates device metrics
- `POSITION_APP` → updates device trackers

### Service Actions Pattern
Services in `services.py` use device/entity targeting via selectors. Actions resolve gateway device, extract node ID from entity attributes, then call `api.send_*()` methods. Always includes 2+ second delay recommendation due to Meshtastic firmware queue limitations.

### Multi-Gateway Support
Integration supports multiple config entries (multiple gateways). Each gets:
- Separate `MeshtasticData` runtime_data
- Own coordinator with filtered node data
- Unique event bus subscriptions with `config_entry_id` filtering

## Common Pitfalls

1. **Don't poll aggressively** - Updates are push-based via events. The coordinator's 1-hour interval is fallback only.
2. **Filter nodes early** - Use `get_nodes()` helper instead of accessing `coordinator.data` directly to respect user's node selection.
3. **Async context managers** - All connection objects require `async with`. Forgetting breaks cleanup.
4. **Protobuf imports** - Always import from `.aiomeshtastic.protobuf`, not top-level `meshtastic`.
5. **Device triggers need gateway** - Only gateway nodes have full trigger/action support. Non-gateway nodes have limited actions.

## File Organization
- `custom_components/meshtastic/` - Integration root
  - Core: `__init__.py`, `api.py`, `coordinator.py`, `config_flow.py`
  - Platforms: `sensor.py`, `binary_sensor.py`, `device_tracker.py`, `notify.py`, `text.py`
  - Services: `services.py`, `device_action.py`, `device_trigger.py`
  - Features: `frontend.py`, `logbook.py`
  - Data models: `const.py`, `data.py`, `helpers.py`, `entity.py`
  - Sub-packages: `aiomeshtastic/`, `meshtastic_tcp/`, `meshtastic_web/`, `ha_frontend/`

## Testing Approach
Currently no automated tests. Manual testing with actual Meshtastic devices required. Development container provides HA instance at `http://localhost:8123`.

## Key Constants
- `DOMAIN = "meshtastic"`
- Config versions: `CURRENT_CONFIG_VERSION_MAJOR/MINOR` (update triggers migration)
- Default ports: TCP 4403, proxy varies by config
- Connection types: `ConnectionType.TCP | SERIAL | BLUETOOTH`
