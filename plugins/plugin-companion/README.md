# @elizaos/plugin-companion

Opt-in plugin that lets an Eliza agent drive a Waveshare ESP32-S3 companion
device (mood display + touch sensor) over the device's authenticated JSON
WebSocket protocol. The device is the WebSocket server (SoftAP); the agent is
the client.

## Configuration

| Setting | Required | Description |
| --- | --- | --- |
| `COMPANION_WS_URL` | yes | `ws://<device>:8080/api/companion/device-bridge` |
| `COMPANION_PAIRING_TOKEN` | yes | Pairing token appended as `?token=` |

Optional timing overrides (milliseconds): `COMPANION_PING_INTERVAL_MS`,
`COMPANION_PONG_TIMEOUT_MS`, `COMPANION_COMMAND_TIMEOUT_MS`,
`COMPANION_RECONNECT_DELAY_MS`.

The plugin never auto-enables and is desktop/node only. Add
`@elizaos/plugin-companion` to a character's plugin list and set both required
settings; a missing token or URL fails fast at service start.

## Surface

- **`SET_COMPANION_MOOD`** — sends `SET_MOOD` with a `correlationId`, waits
  for the matching `commandResult`, returns the device-confirmed mood.
  Invalid moods are typed failures.
- **`GET_COMPANION_STATUS`** — returns `deviceId`, mood, connection state,
  firmware, and capabilities; fails closed when disconnected.
- **`companionDevice` provider** — surfaces the last device event
  (`touch`, `mood_changed`) and live connection state as context.

## Protocol

Device frames: `welcome`, `register` (`deviceId`, `firmware`,
`capabilities`), `commandResult`, `event`, `pong`. Host frames: `SET_MOOD`,
`GET_STATUS`, `ping`. No host command is sent before the `welcome` →
`register` handshake completes with a non-empty `deviceId`; a missed pong
marks the socket stale, rejects pending commands, and reconnects.

## Tests

`bun run --cwd plugins/plugin-companion test` runs a deterministic
mock-device suite against a real in-process `ws` server: handshake ordering,
bad token, correlation matching, invalid mood, touch events, keepalive
staleness, malformed JSON, and disconnect fail-closed behavior.
