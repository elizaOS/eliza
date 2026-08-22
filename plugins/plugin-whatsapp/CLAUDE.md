# @elizaos/plugin-whatsapp

This plugin is the first-party WhatsApp connector. It uses the bundled `@whiskeysockets/baileys` library in-process and must not add Meta Cloud API, webhook, hosted bridge, daemon, subprocess, or separately installed application paths.

## Runtime

- `src/runtime-service.ts` owns connector registration and message flow.
- `src/clients/baileys-client.ts` and `src/baileys/` own the direct socket, auth state, normalization, and QR data.
- `src/setup-routes.ts` owns authenticated pair, status, stop, and disconnect routes.
- `src/accounts.ts` owns session-directory and access-policy resolution.
- `src/connector-account-provider.ts` maps paired sessions into connector accounts.

The plugin exposes no public inbound webhook. Pairing writes a Baileys session directory into the connector configuration, and runtime activation requires an `authDir`. Named accounts must use distinct normalized account IDs and distinct session boundaries.

## Commands

```bash
bun run --cwd plugins/plugin-whatsapp test
bun run --cwd plugins/plugin-whatsapp typecheck
bun run --cwd plugins/plugin-whatsapp lint:check
bun run --cwd plugins/plugin-whatsapp build
```

Tests must exercise the real Baileys library boundary where network access is not required. Mocks may drive socket events but cannot stand in for activation or session persistence proof. Live send/receive evidence requires a real paired WhatsApp account.

Keep `CLAUDE.md` and `AGENTS.md` byte-for-byte identical and run `bun run check:agents-claude` after changes.
