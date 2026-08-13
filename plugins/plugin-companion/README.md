# @elizaos/plugin-companion

Opt-in WebSocket client so an elizaOS agent can drive an ESP32 companion
device (mood, status, touch events). The device hosts SoftAP + the bridge;
Eliza connects as the client.

## Install

Add `@elizaos/plugin-companion` to a character's plugin list. Set:

- `COMPANION_WS_URL` — `ws://192.168.4.1:8080/api/companion/device-bridge`
- `COMPANION_PAIRING_TOKEN` — must match the device token

Join the board's SoftAP (`ELIZA-XXXXXX`) first. Hardware is not required for
CI; tests use a mock WebSocket device.

## Actions

- `SET_COMPANION_MOOD` — `idle` / `listening` / `thinking` / `happy`
- `GET_COMPANION_STATUS` — fails closed when disconnected

Related issue: https://github.com/elizaOS/eliza/issues/18957
