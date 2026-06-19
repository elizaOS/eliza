# Server Workspace Overview

This workspace contains configuration snapshots from a production Linux server running multiple web projects.

## Hosted Sites

1. **www.fzw.best** — A Laravel application with a cyberpunk theme
   - Document root: `/www/wwwroot/www.fzw.best/public`
   - Nginx vhost config: `www/server/panel/vhost/nginx/www.fzw.best.conf`
   - Rewrite rules: `www/server/panel/vhost/rewrite/www.fzw.best.conf`

2. **auth.wslf.cc** — A PHP authentication service
   - Document root: `/www/wwwroot/auth.wslf.cc`
   - Has admin panel and API endpoints

## Services

- **Moltbot** — AI agent framework
  - Installation docs: `opt/moltbot/docs/`
  - Active config: `home/admin/.moltbot/moltbot.json`
  - Supports Telegram channel plugin

## File Structure

- `etc/` — System network configuration
- `home/admin/` — Admin user home directory (Moltbot config)
- `opt/moltbot/` — Moltbot installation documentation
- `www/server/` — Web server configs (nginx vhosts, SSL, PHP handler)

## Notes

- SSL certificates are managed via Let's Encrypt
- Server panel (BT Panel) manages site configurations at `www/server/panel/`
- Some configuration files have `.new` variants representing proposed but not-yet-applied changes
