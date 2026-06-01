# @elizaos/plugin-anthropic-proxy

Routes Anthropic API traffic from your eliza agent through a **Claude Max / Pro subscription** instead of paying per-token Extra Usage rates.

The plugin applies a 7-layer bidirectional transformation pipeline so requests look like they originate from the official Claude Code CLI:

1. Billing header injection (`x-anthropic-billing-header` text block carrying the CC version plus a 3-character SHA256 fingerprint computed per request)
2. String trigger sanitization
3. Tool name fingerprint bypass (PascalCase CC convention rename)
4. System prompt template bypass (strip + paraphrase)
5. Tool description stripping (reduce schema fingerprint)
6. Schema property name renaming
7. Full bidirectional reverse mapping on SSE + JSON responses

Plus assistant-prefill stripping and thinking-block stripping for replay/session bugs.

The default fingerprint dictionaries target the elizaOS tool surface (`@elizaos/native-reasoning`). For non-eliza agents, supply your own dictionaries via `config.json` (see `config.json.example`).

## Custom fingerprint dictionaries

The defaults make this plugin a one-line drop-in for any eliza agent. If you're running a non-eliza agent (LangChain, LlamaIndex, your own runtime, etc.) the eliza tool-name dictionary won't match your tool surface and you'll want to supply your own.

Drop a `config.json` next to your eliza root with the shape shown in `config.json.example`. The plugin merges it over the defaults at startup. Any of the four dictionaries (`replacements`, `toolRenames`, `propRenames`, `reverseMap`) can be overridden independently — the rest fall back to the eliza defaults.

## You own the subscription

This plugin **does not** route your traffic through any service operated by anyone but you. It needs **your** Claude Code OAuth token (from your own subscription on your own machine). You are responsible for whether your usage complies with Anthropic's terms.

## Setup

```bash
# 1. Install Claude Code CLI and log in once on this machine.
claude auth login

# 2. Add the plugin to your agent's plugin list (your character file or
#    plugin loader). It will:
#    - Start an in-process proxy on http://127.0.0.1:18801
#    - Set ANTHROPIC_BASE_URL to that proxy URL (unless you've set it
#      explicitly to something else)
```

## Modes

Pick via `CLAUDE_MAX_PROXY_MODE`:

| Mode     | What it does                                                                |
| -------- | --------------------------------------------------------------------------- |
| `inline` | (default) Plugin starts an http proxy in this agent's process               |
| `shared` | Plugin connects to an existing upstream proxy URL (one host, many agents)   |
| `off`    | Plugin loads but doesn't start anything (passthrough; you set `ANTHROPIC_BASE_URL` yourself) |

In `inline` mode each agent gets its own proxy server. In `shared` mode you run the proxy once on the host (or via this same plugin in a different agent) and point all your agents at the same `CLAUDE_MAX_PROXY_UPSTREAM`. Useful when you have many agents on one box and only one Claude subscription.

## Environment variables

| Variable                    | Default                       | Notes                                                                |
| --------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `CLAUDE_MAX_PROXY_MODE`     | `inline`                      | `inline` / `shared` / `off`                                          |
| `CLAUDE_MAX_PROXY_PORT`     | `18801`                       | inline mode listen port                                              |
| `CLAUDE_MAX_PROXY_UPSTREAM` | (none)                        | shared mode upstream base URL, e.g. `http://172.18.0.1:18801`        |
| `CLAUDE_MAX_PROXY_BIND_HOST` | `127.0.0.1`                  | inline mode bind address                                             |
| `CLAUDE_MAX_PROXY_VERBOSE`  | `false`                       | extra request logging                                                |
| `CLAUDE_MAX_CREDENTIALS_PATH` | (auto)                      | path to `.credentials.json`; defaults to `~/.claude/.credentials.json` |
| `CLAUDE_CODE_OAUTH_TOKEN`   | (none)                        | direct OAuth bearer token; takes precedence over the file            |
| `ANTHROPIC_BASE_URL`        | (auto-set by plugin)          | leave unset and the plugin picks. Set to `auto` to opt back in if you ever set it. Set to anything else and the plugin will leave it alone. |

## Diagnostics

- HTTP route: `GET /api/anthropic-proxy/status` returns the current mode, URL, listening state, request count, token expiry, and (in shared mode) upstream reachability.
- Action: `PROXY_STATUS` returns the same info to a chat surface.
- Local proxy health: `GET http://127.0.0.1:18801/health` (replace port to match config).

## Token refresh

If you hit a 401 (token expired) run:

```bash
claude auth login
```

The plugin re-reads the credentials file on every request, so a fresh login is picked up immediately — no need to restart the agent.

## Failure modes (intentional)

- **Missing credentials.** Plugin logs a warning, degrades to `off` mode, agent keeps running. It does not crash.
- **Inline port collision.** Plugin logs the bind error, degrades to `off` mode.
- **Shared upstream unreachable at startup.** Plugin still boots in `shared` mode; the unreachable upstream is reported via `/api/anthropic-proxy/status`.

## Plugin shape

- `services: [AnthropicProxyService]` — Service that owns the http server lifecycle (start/stop)
- `actions: [proxyStatusAction]` — `PROXY_STATUS` action for in-chat diagnostics
- `routes: anthropicProxyRoutes` — `GET /api/anthropic-proxy/status` for external tools
- `init()` — sets `ANTHROPIC_BASE_URL` if you haven't already

## Files

```
plugins/plugin-anthropic-proxy/
├── index.ts                           # Plugin export + init
├── index.node.ts                      # Node entry
├── index.browser.ts                   # Browser noop
├── auto-enable.ts                      # shouldEnable() opt-in check
├── config.json.example                # Custom fingerprint dictionary shape
├── build.ts                           # Bun build script
├── package.json
├── tsconfig.json / tsconfig.build.json
├── vitest.config.ts
├── bunfig.toml
├── src/
│   ├── proxy/
│   │   ├── constants.ts               # Algorithm constants + DEFAULT_* dict re-exports
│   │   ├── eliza-fingerprint.ts       # ELIZA_* default fingerprint dictionaries
│   │   ├── billing-fingerprint.ts     # Layer 1: SHA256 fingerprint
│   │   ├── sanitize.ts                # Layer 2: string sanitize
│   │   ├── tool-rename.ts             # Layer 3/6: quoted name renames
│   │   ├── system-prompt.ts           # Layer 4: system strip + paraphrase
│   │   ├── cc-tool-stubs.ts           # Layer 5: description strip + stubs
│   │   ├── sse-rewrite.ts             # Tail-buffer SSE reverse map
│   │   ├── stainless-headers.ts       # CC-emulating SDK headers
│   │   ├── process-body.ts            # Forward request pipeline
│   │   ├── reverse-map.ts             # Response/SSE reverse pipeline
│   │   └── server.ts                  # http.createServer lifecycle
│   ├── services/
│   │   └── proxy-service.ts           # AnthropicProxyService extends Service
│   ├── actions/
│   │   └── proxy-status.action.ts     # PROXY_STATUS action
│   ├── routes/
│   │   └── status-route.ts            # /api/anthropic-proxy/status
│   └── utils/
│       └── credentials-loader.ts      # ~/.claude/.credentials.json + JWT exp
└── __tests__/
    ├── proxy.test.ts
    ├── auto-enable.test.ts
    ├── eliza-fingerprint.test.ts
    └── manifest-engine.integration.test.ts
```

