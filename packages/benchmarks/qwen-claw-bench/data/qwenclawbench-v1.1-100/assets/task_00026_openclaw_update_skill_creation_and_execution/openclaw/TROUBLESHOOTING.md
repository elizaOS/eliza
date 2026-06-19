# OpenClaw Troubleshooting Notes

## Common Issues

### Gateway won't start after update
- Check Node.js version: `node --version` (needs >=20)
- Verify config syntax: `openclaw gateway doctor`
- Check port availability: `lsof -i :3017`

### Telegram bot not responding
- Verify bot token is valid: check with @BotFather
- Ensure webhook URL is reachable from Telegram servers
- Check gateway logs for auth errors

### Memory search returning empty
- Run `openclaw status` to verify memory indexing
- Check that MEMORY.md exists and has content
- Rebuild index: restart gateway with `--reindex`

### WhatsApp QR code not showing
- WhatsApp integration requires `whatsapp.enabled: true` in config
- Need to install `@whiskeysockets/baileys` separately
- Device must be on same network for initial pairing

## Update Checklist
1. Backup config: `./backup.sh`
2. Stop gateway: `openclaw gateway stop`
3. Update: `npm install -g openclaw@latest`
4. Check breaking changes in CHANGELOG.md
5. Restart: `openclaw gateway start`
6. Verify: `openclaw status`

## Environment
- macOS Sonoma 14.5 (arm64)
- Node.js v22.11.0
- npm 10.9.0
- Homebrew prefix: /opt/homebrew
