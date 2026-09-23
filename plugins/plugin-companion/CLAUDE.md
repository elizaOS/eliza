# @elizaos/plugin-companion

Opt-in bridge to a Waveshare ESP32-S3 companion device. The device runs its
own firmware and acts as the WebSocket **server**
(`ws://<device>:8080/api/companion/device-bridge?token=<PAIRING_TOKEN>`); this
plugin is the client.

## Architecture

- `src/protocol.ts` — the single trust boundary for inbound frames.
  `parseDeviceFrame` yields a typed frame or throws
  `ElizaError(COMPANION_BAD_FRAME)`; nothing downstream touches raw JSON.
- `src/service.ts` — `CompanionService` owns the full socket lifecycle:
  pairing-token connect, `welcome` → `register` handshake gating (no host
  command before a registered `deviceId`), correlationId-matched commands,
  ping/pong keepalive with stale-socket disconnect, bounded reconnect, and a
  generation counter so stale sockets can never resurrect state.
- `src/actions.ts` — `SET_COMPANION_MOOD`, `GET_COMPANION_STATUS`. Both fail
  closed (structured failed `ActionResult`) on disconnect or device rejection;
  the firmware is the authority on valid moods.
- `src/provider.ts` — `companionDevice` provider surfacing connection, mood,
  and the last device event (`touch`, `mood_changed`).

## Invariants

- Opt-in only: no `autoEnable`, registered in the agent's
  `UNBUNDLED_OPTIONAL_PLUGINS` with `skipOnMobile` — never baked into the
  mobile APK.
- `COMPANION_WS_URL` and an explicit `COMPANION_PAIRING_TOKEN` are required;
  the service throws typed errors at start rather than idling half-configured.
- Protocol garbage from the device (malformed JSON, unknown frames,
  uncorrelated results) is reported via `runtime.reportError` and never kills
  the service.

## Validation

```bash
bun run --cwd plugins/plugin-companion test        # deterministic mock-device suite (real ws server)
bun run --cwd plugins/plugin-companion typecheck
bun run --cwd plugins/plugin-companion lint:check
```

Hardware runs are evidence-only, never a CI gate. Keepalive and command
timeouts are tunable via `COMPANION_PING_INTERVAL_MS`,
`COMPANION_PONG_TIMEOUT_MS`, `COMPANION_COMMAND_TIMEOUT_MS`, and
`COMPANION_RECONNECT_DELAY_MS` (used by the tests; defaults suit hardware).
