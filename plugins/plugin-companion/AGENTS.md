# @elizaos/plugin-companion

Opt-in ESP32 companion bridge for elizaOS. The agent is a WebSocket **client**;
the device (Waveshare ESP32-S3-Touch-LCD-1.69 firmware) remains the server.

## Purpose / role

Lets a character drive a physical companion face: set mood, read device status,
and observe touch events. Dormant unless a character lists
`@elizaos/plugin-companion` (no `autoEnable`). Desktop/node only — listed in
`UNBUNDLED_OPTIONAL_PLUGINS` and skipped on mobile.

## Plugin surface

| Kind | Name | Description |
|------|------|-------------|
| Service | `COMPANION_SERVICE` | WebSocket client: handshake, SET_MOOD, GET_STATUS, ping/pong, events |
| Action | `SET_COMPANION_MOOD` | Send `SET_MOOD`; invalid moods fail closed |
| Action | `GET_COMPANION_STATUS` | Send `GET_STATUS`; disconnected fails closed |
| Provider | `companionDevice` | connected, deviceId, mood, lastEvent |

## Protocol

See firmware `PROTOCOL.md`. Frames:

- Device → host: `welcome`, `register`, `pong`, `event` (`touch`, `mood_changed`), `commandResult`
- Host → device: `ping`, `command` (`SET_MOOD`, `GET_STATUS`)
- Pairing: `?token=` on `/api/companion/device-bridge`

Moods: `idle` | `listening` | `thinking` | `happy` (`ready` → happy).

## Layout

```
src/
  index.ts                 companionPlugin
  protocol.ts              frame types + parse/build
  companion-client.ts      ws client
  companion-service.ts     COMPANION_SERVICE
  actions/set-mood.ts
  actions/get-status.ts
  providers/companion-device.ts
  __tests__/
```

## Commands

```bash
bun run --cwd plugins/plugin-companion typecheck
bun run --cwd plugins/plugin-companion test
bun run --cwd plugins/plugin-companion build
```

## Config / env vars

Read via `runtime.getSetting` (not `process.env`):

| Setting | Required | Notes |
|---------|----------|-------|
| `COMPANION_WS_URL` | To auto-connect | e.g. `ws://192.168.4.1:8080/api/companion/device-bridge` |
| `COMPANION_PAIRING_TOKEN` | To connect | Query token; missing token is rejected |

## How to extend

Keep firmware polarity (device is the WS server) unless you also change the
ESP32 client. Add commands in `protocol.ts` + firmware together.
