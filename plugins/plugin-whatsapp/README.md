# @elizaos/plugin-whatsapp

Direct WhatsApp messaging for elizaOS through the bundled `@whiskeysockets/baileys` library. The plugin runs the WhatsApp Web protocol in-process; it does not require Meta Cloud API, a hosted bridge, a daemon, or another installed application.

## Capabilities

- QR-code pairing with persistent Baileys session state
- Inbound and outbound text and media messages
- Reactions, contact resolution, chat context, and message search
- Multiple paired accounts with DM and group access policies

## Setup

Add a `connectors.whatsapp` block or load the plugin explicitly, then use the authenticated setup routes:

```text
POST /api/whatsapp/pair
GET  /api/whatsapp/status?accountId=default
POST /api/whatsapp/pair/stop
POST /api/whatsapp/disconnect
```

The pairing route broadcasts a `whatsapp-qr` event containing a QR data URL. Scanning it stores the session directory in connector configuration. For non-interactive deployments, set `WHATSAPP_AUTH_DIR` to an existing paired Baileys session directory.

Access policy settings are `WHATSAPP_DM_POLICY`, `WHATSAPP_GROUP_POLICY`, `WHATSAPP_ALLOW_FROM`, and `WHATSAPP_GROUP_ALLOW_FROM`. `WHATSAPP_AUTO_REPLY` remains off by default.

## Multi-account

Configure named accounts under `character.settings.whatsapp.accounts.<id>`. Each account owns its `authDir`; policy defaults may be inherited from the top-level WhatsApp configuration.

## Verification

```bash
bun run --cwd plugins/plugin-whatsapp test
bun run --cwd plugins/plugin-whatsapp typecheck
bun run --cwd plugins/plugin-whatsapp lint:check
```

Live delivery proof requires a real WhatsApp account and QR scan. Deterministic tests cover the direct Baileys connection contract and ensure removed Cloud API activators cannot reappear.

## License

MIT
