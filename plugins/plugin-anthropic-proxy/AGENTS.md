# @elizaos/plugin-anthropic-proxy

Routes Anthropic API traffic from an Eliza agent through a Claude Max/Pro subscription via Claude Code OAuth tokens, bypassing per-token Extra Usage billing.

## Purpose / role

This plugin is **opt-in** middleware — it is **not** enabled by default. Set `CLAUDE_MAX_PROXY_MODE=inline` or `CLAUDE_MAX_PROXY_MODE=shared` to activate. When active it starts (or connects to) an in-process HTTP proxy and self-injects `ANTHROPIC_BASE_URL` so `plugin-anthropic` routes transparently through the proxy without further configuration.

The plugin applies a 7-layer bidirectional transformation pipeline that makes outbound Anthropic API calls look like they originate from the official Claude Code CLI, using the agent's own Claude subscription and OAuth token. The default fingerprint dictionaries target the elizaOS tool surface (`@elizaos/native-reasoning`). Non-elizaOS tool surfaces need a custom `config.json` — see `config.json.example`.

## Plugin surface

| Kind | Name | What it does |
|---|---|---|
| Service | `AnthropicProxyService` (`"anthropic-proxy"`) | Owns the HTTP proxy lifecycle (start/stop). Inline mode: binds a local server. Shared mode: validates upstream URL. Off: runs without a proxy. |
| Action | `PROXY_STATUS` | Returns proxy mode, bound URL, listening state, request count, token expiry, upstream reachability to a chat surface. Similes: `ANTHROPIC_PROXY_STATUS`, `CLAUDE_MAX_PROXY_STATUS`, `CHECK_PROXY`. |
| Route | `GET /api/anthropic-proxy/status` | Same diagnostic data as `PROXY_STATUS`, exposed over HTTP for external tooling. |
| `init()` | — | Sets `ANTHROPIC_BASE_URL` after the service starts (skipped if already set to a non-`auto` value). |
| `autoEnable` / `auto-enable.ts` | — | Enables the plugin only when `CLAUDE_MAX_PROXY_MODE` is `inline` or `shared`. |

No providers or evaluators.

## Layout

```
plugins/plugin-anthropic-proxy/
├── index.ts                        # Plugin definition + init(); re-exports public API
├── index.node.ts                   # Node-specific entry (imports from index.ts)
├── index.browser.ts                # Browser-unavailable entry
├── auto-enable.ts                  # shouldEnable() — lightweight, no transitive imports
├── config.json.example             # Custom fingerprint dictionary shape
├── src/
│   ├── proxy/
│   │   ├── constants.ts            # Algorithm constants + DEFAULT_* dict references
│   │   ├── eliza-fingerprint.ts    # Eliza-specific fingerprint dictionaries (layers 2/3/4/6)
│   │   ├── billing-fingerprint.ts  # Layer 1: SHA256 billing header (CC identity)
│   │   ├── sanitize.ts             # Layer 2: string find/replace helpers
│   │   ├── tool-rename.ts          # Layer 3/6: quoted token renames
│   │   ├── system-prompt.ts        # Layer 4: system prompt strip + paraphrase
│   │   ├── cc-tool-injection.ts    # Layer 5: synthetic CC tool injection
│   │   ├── sse-rewrite.ts          # SSE stream line parser + reverse-map application
│   │   ├── stainless-headers.ts    # Stainless SDK headers to emulate CC user-agent
│   │   ├── process-body.ts         # Forward pipeline: layers 1-6 applied to request body
│   │   ├── reverse-map.ts          # Reverse pipeline: applied to response body + SSE
│   │   └── server.ts               # ProxyServer — node:http server, per-request pipeline
│   ├── services/
│   │   └── proxy-service.ts        # AnthropicProxyService extends Service; resolveConfig()
│   ├── actions/
│   │   └── proxy-status.action.ts  # PROXY_STATUS action
│   ├── routes/
│   │   └── status-route.ts         # GET /api/anthropic-proxy/status handler
│   └── utils/
│       └── credentials-loader.ts   # loadCredentials() — reads ~/.claude/.credentials.json
└── __tests__/
    ├── proxy.test.ts
    ├── auto-enable.test.ts
    ├── eliza-fingerprint.test.ts
    ├── manifest-engine.integration.test.ts
    ├── process-body.edge.test.ts
    ├── proxy-server.routing.test.ts
    ├── sse-rewrite.test.ts
    └── error-policy.shape.test.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-anthropic-proxy build       # Bun.build() (build.ts)
bun run --cwd plugins/plugin-anthropic-proxy dev         # watch build
bun run --cwd plugins/plugin-anthropic-proxy typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-anthropic-proxy test        # vitest run
bun run --cwd plugins/plugin-anthropic-proxy clean       # rm dist .turbo
```

## Config / env vars

| Variable | Default | Required | Notes |
|---|---|---|---|
| `CLAUDE_MAX_PROXY_MODE` | `inline` | Yes (for activation) | `inline` / `shared` / `off`. Unset = plugin does not auto-enable. |
| `CLAUDE_MAX_PROXY_PORT` | `18801` | No | Inline mode listen port. |
| `CLAUDE_MAX_PROXY_BIND_HOST` | `127.0.0.1` | No | Inline bind address. Non-loopback requires `CLAUDE_MAX_PROXY_AUTH_TOKEN`. |
| `CLAUDE_MAX_PROXY_UPSTREAM` | — | Yes (shared mode) | Upstream proxy base URL, e.g. `http://172.18.0.1:18801`. Must be HTTPS or a private/loopback host. |
| `CLAUDE_MAX_PROXY_AUTH_TOKEN` | — | Conditionally | Required when `CLAUDE_MAX_PROXY_BIND_HOST` is not loopback. Checked via `Authorization: Bearer <token>` or `x-claude-max-proxy-token` header. |
| `CLAUDE_MAX_PROXY_VERBOSE` | `false` | No | Log each proxied request. |
| `CLAUDE_MAX_PROXY_CONFIG_PATH` | — | No | Explicit path to a `config.json` fingerprint override file. Takes precedence over a `config.json` found next to the agent root. If set and the file is missing, `resolveConfig()` records a `configError` but the agent keeps running. |
| `CLAUDE_MAX_CREDENTIALS_PATH` | — | No | Explicit path to `.credentials.json`. Defaults to `~/.claude/.credentials.json`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | No | Bearer token directly; takes precedence over the file. |
| `ANTHROPIC_BASE_URL` | (auto-set) | No | Leave unset and the plugin sets it. Set to `auto` to allow the plugin to override an existing value. Any other value is left untouched. |

Credential search order in `loadCredentials()`: `CLAUDE_CODE_OAUTH_TOKEN` env → `CLAUDE_MAX_CREDENTIALS_PATH` → `~/.claude/.credentials.json` → `~/.claude/credentials.json`.

If credentials are missing the service degrades to `off` mode and logs a warning — the agent keeps running without a proxy.

## How to extend

**Add a new action:**
1. Create `src/actions/<name>.action.ts` exporting a `const myAction: Action`.
2. Import it in `index.ts` and add it to the `actions: [...]` array.

**Add a new route:**
1. Add a handler function and a new `Route` entry to `src/routes/status-route.ts`, or create a new file and import into `anthropicProxyRoutes`.
2. Add it to the `routes: anthropicProxyRoutes` array in `index.ts`.

**Update fingerprint dictionaries:**
Edit `src/proxy/eliza-fingerprint.ts`. The four arrays (`ELIZA_REPLACEMENTS`, `ELIZA_TOOL_RENAMES`, `ELIZA_PROP_RENAMES`, `ELIZA_REVERSE_MAP`) are re-exported as the `DEFAULT_*` constants in `constants.ts` and picked up automatically by `ProxyServer`.

**Custom dictionaries for a non-elizaOS tool surface:**
Drop a `config.json` (shape: `config.json.example`) next to the agent root, or point `CLAUDE_MAX_PROXY_CONFIG_PATH` at the file. Any of the four dictionary arrays (`replacements`, `toolRenames`, `propRenames`, `reverseMap`) is merged over the eliza defaults at startup.

## Conventions / gotchas

- **Node-only.** The `index.browser.ts` entry is browser-unavailable; `package.json` guards with `"eliza.platforms": ["node"]`.
- **`auto-enable.ts` must stay lightweight.** The manifest engine loads it for every plugin at boot. No transitive imports; env reads only.
- **`ANTHROPIC_BASE_URL` side-effect.** The service sets this process-level env var on start. If another plugin or the agent shell already set it to a real value, the proxy will not override it (only overrides unset or `"auto"`).
- **Credentials are re-read per request.** A fresh `claude auth login` is picked up immediately with no agent restart.
- **Inline mode requires a Claude Code login on the host machine.** If credentials are absent, `start()` throws and the service falls back to `off` mode — it does not crash the agent.
- **Non-loopback bind needs auth token.** Binding to `0.0.0.0` or a LAN address without `CLAUDE_MAX_PROXY_AUTH_TOKEN` is rejected at service start.
- **`ProxyServer` and `loadCredentials` are exported** from the package root for use by other plugins that need direct access to the proxy server or credential loading logic.
- See root [AGENTS.md](../../AGENTS.md) for repo-wide rules (logger, ESM, architecture layers, naming).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
