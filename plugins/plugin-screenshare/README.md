# @elizaos/plugin-screenshare

Screen Share plugin for elizaOS. Streams the local desktop and accepts authenticated remote mouse and keyboard control from any connected viewer.

## What it does

When loaded, the plugin:

- Creates and manages **screen-share sessions** backed by the local machine's desktop.
- Serves a **self-contained viewer** (`/api/apps/screenshare/viewer`) — a single HTML page that streams live screenshots and relays clicks, key presses, and scrolls back to the host.
- Provides an **operator surface** inside the elizaOS dashboard (a React panel) where you can start, stop, copy, and open host sessions, and connect to a remote session by entering its server URL, session ID, and token.
- Exposes a **TUI view** (`/screenshare/tui`) that renders session and capability state in a terminal-friendly layout.
- All desktop capture and input dispatch is handled by `@elizaos/plugin-computeruse`, which supports macOS, Linux, and Windows.

## Capabilities

| Feature | Detail |
|---------|--------|
| Screen streaming | Polls live desktop screenshots at ~500 ms intervals; serves as PNG |
| Mouse control | Click, double-click, right-click, move, scroll |
| Keyboard control | Text input (up to 4096 chars), keypress combos (Enter, Escape, Tab, arrows, etc.) |
| Window listing | Lists open desktop windows |
| Session management | Create, list, and stop sessions; one active local session at a time |
| Capability detection | Reports which desktop control features are available on the host platform |

## Enabling the plugin

Add `@elizaos/plugin-screenshare` to the agent's plugin list:

```typescript
import screensharePlugin from "@elizaos/plugin-screenshare";

const agent = new AgentRuntime({
  // ...
  plugins: [screensharePlugin],
});
```

The plugin is an elizaOS **app** (`kind: app`, `launchType: connect`). It is gated behind a valid app session — the viewer URL includes a session ID and a per-session bearer token that are generated at session creation time.

## API overview

All routes live under `/api/apps/screenshare/`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/capabilities` | Platform + desktop control capability flags |
| GET | `/windows` | List open desktop windows |
| GET | `/sessions` | All sessions (public fields; no tokens) |
| POST | `/session` | Start a new session; returns `{ session, token, viewerUrl }` |
| GET | `/session/:id` | Session state (requires token) |
| GET | `/session/:id/frame` | Current desktop screenshot as PNG (requires token) |
| POST | `/session/:id/input` | Send mouse/keyboard input (requires token) |
| POST | `/session/:id/stop` | Stop the session (requires token) |
| GET | `/viewer` | Self-contained viewer HTML |

Token is passed via `?token=` query param, `X-Screenshare-Token` header, or `Authorization: Bearer <token>` header.

## Security notes

- Tokens are 24-byte cryptographically random base64url strings generated per session.
- Session creation is rate-limited to 10 requests per IP per minute.
- Keypress input is validated against an allowlist (`[A-Za-z0-9+_.,: -]`, max 128 chars).
- Text input is capped at 4096 characters.
- Sessions are in-memory only; they are lost on process restart.

## Requirements

Desktop capture and input control depend on the host platform. The `/capabilities` endpoint reports which features are available. For full functionality, the agent must run on a machine with a graphical display session (not headless).

## Development

```bash
bun run --cwd plugins/plugin-screenshare build    # full build
bun run --cwd plugins/plugin-screenshare test     # run tests
bun run --cwd plugins/plugin-screenshare clean    # remove dist
```

See `CLAUDE.md` / `AGENTS.md` for the agent-oriented layout and extension guide.
