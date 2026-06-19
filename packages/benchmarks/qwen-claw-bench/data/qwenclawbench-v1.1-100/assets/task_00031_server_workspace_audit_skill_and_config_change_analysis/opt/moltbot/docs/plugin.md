# Moltbot Plugin System

## Overview

Moltbot supports a modular plugin architecture. Plugins are loaded from the `skills/` directory and registered via the plugin manifest.

## Plugin Structure

```
skills/
  my-plugin/
    SKILL.md          # Plugin documentation and instructions
    package.json      # Plugin metadata (optional)
    scripts/          # Executable scripts
    references/       # Reference docs, schemas
```

## Plugin Lifecycle

1. **Discovery** — Moltbot scans `skills/` on startup
2. **Registration** — Each plugin's SKILL.md is parsed for metadata
3. **Initialization** — Plugin scripts are loaded into the runtime
4. **Execution** — Plugins respond to events and commands

## Configuration

Plugin-specific config goes in `~/.moltbot/moltbot.json` under the `plugins` key:

```json
{
  "plugins": {
    "telegram": {
      "enabled": true,
      "token": "BOT_TOKEN_HERE",
      "allowedUsers": []
    }
  }
}
```

## Channel Plugins

Channel plugins provide messaging integrations. See `docs/channels/` for specifics:

- [Telegram](channels/telegram.md)
- BlueBubbles (WIP)

## Writing a Plugin

1. Create a directory under `skills/`
2. Add a `SKILL.md` with description, triggers, and instructions
3. Add scripts to `scripts/` directory
4. Register any config schema in your SKILL.md

## Events

Plugins can listen for:
- `message.incoming` — New message received
- `message.outgoing` — Message being sent
- `command.execute` — Slash command triggered
- `heartbeat` — Periodic health check
- `channel.connect` — Channel comes online
- `channel.disconnect` — Channel goes offline

## Error Handling

Plugins should catch their own errors. Uncaught exceptions will be logged but won't crash the main process. Use the built-in logger:

```javascript
const log = require('../src/logger');
log.info('Plugin loaded');
log.error('Something went wrong', err);
```
