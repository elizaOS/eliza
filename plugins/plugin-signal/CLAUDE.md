# @elizaos/plugin-signal

## Purpose

This package is an explicit unsupported compatibility boundary. It must not
advertise or activate Signal messaging until elizaOS ships a reviewed,
distributable, in-process Signal client.

## Invariants

- Do not spawn, install, probe, or call `signal-cli`, `signald`, a REST daemon,
  or another external application.
- Do not add connector sources, services, routes, UI setup, registry channels,
  synthetic success fixtures, or auto-enable behavior while unsupported.
- Explicit package initialization throws the typed
  `SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE` error.
- A future implementation must store credentials in the canonical vault and
  prove the real encrypted send, receive, link, restart, group, and attachment
  contracts without an external process.

## Validation

Run `bun run --cwd plugins/plugin-signal test`, `typecheck`, and `lint:check`,
plus the repository retired-transport activation ratchet.
