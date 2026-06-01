# @elizaos/plugin-feed

An elizaOS plugin that connects an Eliza agent to the [Feed](https://feed.market) prediction market game. It adds an operator dashboard (standard, XR, and terminal views) and a full HTTP proxy layer so the elizaOS agent can read and write Feed markets, posts, chats, and team state.

## What it does

- Embeds the Feed operator dashboard as a first-class elizaOS view (accessible in the agent manager, desktop tab, and terminal TUI).
- Proxies requests between the elizaOS API surface and the Feed backend: agent status, market data, prediction trades, perpetual positions, social posts, chat messages, team management, and admin controls.
- Handles Feed agent authentication automatically, including token caching and auto-refresh on 401.
- In development, attempts to auto-provision credentials from a local Feed dev server.
- Exposes a postMessage auth token so the embedded Feed web viewer can authenticate without a separate login.

## Capabilities / views

| View | Type | Description |
|------|------|-------------|
| Feed | standard | Full operator dashboard |
| Feed XR | xr | XR-compatible operator surface |
| Feed TUI | tui | Terminal operator dashboard with commands: `get-state`, `refresh-agent-status`, `open-live-dashboard`, `send-team-message` |

## Required configuration

Set these env vars (or agent character secrets) before enabling the plugin:

| Variable | Required | Description |
|----------|----------|-------------|
| `FEED_AGENT_ID` | Yes | Your Feed agent identifier |
| `FEED_AGENT_SECRET` | Yes | Your Feed agent secret |
| `FEED_API_URL` | No | Feed backend URL (default: `http://localhost:3000` dev, `https://staging.feed.market` prod) |
| `FEED_CLIENT_URL` | No | Client URL used for the embedded viewer and launch link |
| `FEED_A2A_API_KEY` | No | Agent-to-agent API key (`X-Feed-Api-Key` header) |

In `NODE_ENV !== "production"`, the plugin will probe a local Feed dev server for credentials automatically if `FEED_AGENT_ID` and `FEED_AGENT_SECRET` are not set.

## How to enable

Add `@elizaos/plugin-feed` to your agent character's plugin list:

```json
{
  "name": "My Agent",
  "plugins": ["@elizaos/plugin-feed"],
  "settings": {
    "secrets": {
      "FEED_AGENT_ID": "your-agent-id",
      "FEED_AGENT_SECRET": "your-agent-secret"
    }
  }
}
```

## Building

```bash
bun run --cwd plugins/plugin-feed build
```

This runs three steps: `build:js` (tsup), `build:views` (Vite for the UI bundle), and `build:types` (tsc declarations). Both `build:js` and `build:views` must be run before the plugin works correctly in the elizaOS runtime.

## API routes proxied

The plugin registers routes under `/api/apps/feed/` that proxy to the Feed backend:

- **Agent:** `/agent/status`, `/agent/activity`, `/agent/logs`, `/agent/wallet`, `/agent/goals`, `/agent/stats`, `/agent/summary`, `/agent/recent-trades`, `/agent/chat`, `/agent/card`, `/agent/trading-balance`, `/agent/benchmark`, `/agent/autonomy`, `/agent/toggle`
- **Markets:** `/markets/predictions`, `/markets/predictions/:id`, `/markets/predictions/:id/history`, `/markets/predictions/:id/trades`, `/markets/predictions/:id/buy`, `/markets/predictions/:id/sell`, `/markets/perps`, `/markets/perps/open`, `/markets/perps/preview`, `/markets/perps/position/:id/close`
- **Social:** `/posts`, `/posts/:id`, `/posts/:id/comments`, `/posts/:id/like`
- **Messaging:** `/chats`, `/chats/dm`, `/chats/:id/messages`, `/chats/:id/message`
- **Groups:** `/groups`, `/groups/:id`, `/groups/:id/members`
- **Team:** `/team`, `/team/info`, `/team/chat`, `/team/dashboard`, `/team/conversations`
- **Feed:** `/feed/for-you`, `/feed/hot`, `/trades`
- **Agents:** `/agents/discover`
- **Admin:** `/admin/agents/pause-all`, `/admin/agents/resume-all`
- **SSE:** `/sse` — streams Feed's server-sent events to the client
- **Session:** `/session/:id`, `/session/:id/message`, `/session/:id/control`
