# Changelog

All notable changes to OpenClaw will be documented in this file.

## [2026.2.5] - 2026-02-05

### Added
- Native support for Claude claude-4-20250514 and claude-sonnet-4-20250514 in model routing
- Multi-workspace mode: run multiple isolated workspaces from a single gateway process
- Structured log output (JSON Lines format) available as opt-in via `logging.format: jsonl`

### Fixed
- Heartbeat deduplication preventing duplicate notifications on rapid reconnects
- Memory indexer silently skipping files larger than 5 MB

### Breaking Changes
- **`logging.file` must now be a path relative to the workspace directory.** Absolute paths (e.g., `/var/log/openclaw/gateway.log`) are rejected at gateway startup with a `ConfigError`. Migrate by converting any absolute log paths to workspace-relative paths — for example, change `/var/log/openclaw/gateway.log` to `logs/gateway.log`.
- **`channels.telegram.allowedUsers` renamed to `channels.telegram.allowedUserIds`.** The old key is still accepted in v2026.2.x but emits a startup warning and will be removed in v2026.4.x.

---

## [2026.1.10] - 2026-01-10

### Added
- Plugin hot-reload: reload individual plugins without restarting the gateway
- HTTP API for external tool integrations (disabled by default; enable with `api.enabled: true`)

### Fixed
- Session timeout not correctly applying `runTimeoutSeconds` for long-running tool calls
- Config watcher missing changes to nested YAML keys on Linux inotify

### Breaking Changes
- **`gateway.bind` renamed to `gateway.listen.bind`.** The old key is still accepted in v2026.1.x but emits a deprecation warning at startup and will be removed in v2026.3.x. Migration example:
  ```yaml
  # Before (v2025.x)
  gateway:
    bind: "0.0.0.0:3017"

  # After (v2026.1+)
  gateway:
    listen:
      bind: "0.0.0.0:3017"
  ```

---

## [2025.12.8] - 2025-12-08

### Added
- Support for Claude 3.5 Sonnet in model routing
- New `memory_search` tool for semantic recall across memory files
- Discord thread-bound persistent sessions via `sessions_spawn`

### Fixed
- Heartbeat timing drift when gateway runs >48h without restart
- WhatsApp QR code expiry handling during reconnect
- Memory file locking race condition on concurrent writes

### Changed
- Default model updated to `claude-3.5-sonnet-20241022`
- Increased max context window for session history to 200k tokens
- Improved error messages for missing API keys

## [2025.11.15] - 2025-11-15

### Added
- Brave Search integration (`web_search` tool)
- Canvas snapshot support for node-hosted browsers
- ACP runtime for coding agent sessions

### Fixed
- Telegram bot webhook registration failing on IPv6-only hosts
- Session spawn timeout not respecting `runTimeoutSeconds`

### Changed
- Migrated from `got` to `node-fetch` for HTTP client
- Reduced default heartbeat interval from 45min to 30min

## [2025.10.22] - 2025-10-22

### Added
- Initial public release
- Multi-channel support: Telegram, WhatsApp, Discord, Signal, IRC
- Gateway daemon with hot-reload configuration
- Skill system with SKILL.md convention
- Memory system (MEMORY.md + daily notes)
- Cron job scheduler
- Node pairing for mobile devices
- Browser automation via Playwright
- TTS via ElevenLabs
- Sub-agent orchestration
