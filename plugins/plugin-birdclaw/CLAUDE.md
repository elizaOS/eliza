# @elizaos/plugin-birdclaw

Birdclaw (https://birdclaw.sh) local-first Twitter/X memory for elizaOS: the
agent and the app get a typed window onto the owner's private Twitter archive
— archived timeline, mentions, DMs, likes, and bookmarks in a local SQLite
database — plus live-sync triggers and AI digests.

## Purpose / role

[birdclaw](https://github.com/steipete/birdclaw) is steipete's local-first
Twitter workspace: `birdclaw init` + archive import + optional `xurl`/`bird`
transports populate a single SQLite DB (default `~/.birdclaw/`). Its stable
integration surface is the CLI — "stable `--json` envelopes go to stdout,
progress and warnings to stderr". This plugin wraps that CLI with a service,
gives the agent an owner-gated `BIRDCLAW` action, serves `/api/birdclaw/*`
routes, and registers the **Birdclaw** launcher view (GUI-only shipping; `"tui"`/`"xr"` remain
valid compatibility modality values but are not declared).

Everything degrades explicitly when birdclaw is missing: the view renders a
setup screen with install guidance, data routes return
`503 { installed: false }`, and the action stops validating (the planner never
offers a dead capability).

## Enablement

Auto-on when the host actually has birdclaw (see `birdclawRequested` in
`packages/agent/src/runtime/plugin-collector.ts`): the `birdclaw` binary on
PATH, `BIRDCLAW_BIN`/`BIRDCLAW_HOME` set, or an existing `~/.birdclaw` root.
Never loads on mobile (the CLI cannot exist in a store-build sandbox, so the
tile never appears where it cannot work). Force with config
`agents.defaults.birdclaw: true|false` or `ELIZA_BIRDCLAW=1/0`. Also listed in
`OPTIONAL_CORE_PLUGINS` for admin-panel enablement.

## Plugin surface

### Service

- `BirdclawService` (`serviceType = "BIRDCLAW_SERVICE"`, `src/birdclaw/service.ts`)
  — binary resolution (`BIRDCLAW_BIN` → `birdclaw` on PATH), a 30s-cached
  availability probe (`--version`), and typed methods: `status()` (db stats +
  transport), `searchTweets()`, `inbox()`, `sync(collection)`,
  `digest(period)`. Spawns via `execFile` argv arrays (no shell), with an
  env **allowlist** (PATH, HOME, `BIRDCLAW_HOME`, plus `OPENAI_API_KEY` only
  from the dedicated `BIRDCLAW_OPENAI_API_KEY` knob) — the agent's own
  provider keys are never inherited by the CLI.

### Action

- `BIRDCLAW` (`src/actions/birdclaw.ts`) — owner-only umbrella action with op
  dispatch: `search` (full-text over home/mentions/authored, `--liked`,
  `--bookmarked`), `inbox` (ranked mention/DM triage), `sync`
  (timeline|mentions|authored|likes|bookmarks), `digest`
  (today|24h|yesterday|week; needs birdclaw's OpenAI key), `status`.
  `validate` requires the service to be registered AND the CLI installed
  (cached probe — no per-message process storm).

### Routes (`src/routes/birdclaw-routes.ts`, private, `rawPath`)

- `GET /api/birdclaw/status` — always 200; `{ installed: false, message }`
  drives the view's setup screen.
- `GET /api/birdclaw/tweets?resource=&q=&liked=&bookmarked=&limit=`
- `GET /api/birdclaw/inbox?kind=&limit=`
- `POST /api/birdclaw/sync { collection }`
- `POST /api/birdclaw/digest { period }`
- Errors: 400 invalid params, 502 CLI failure (stderr tail in `error`),
  503 service/binary missing.

### View

- `birdclaw` — `BirdclawView`, path `/birdclaw`, bundle
  `dist/views/bundle.js`, modalities `["gui"]`. Tabs: Timeline /
  Mentions / Posted / Likes / Bookmarks / Inbox; per-tab Sync button (shown
  only when a live transport is installed); needs-reply nudge; chat handoff on
  "Ask" (per the chat-first design law, free-form search lives in the floating
  chat via the BIRDCLAW action, not an input in the view).

## Layout

```
src/
  index.ts                     Public API barrel
  plugin.ts                    birdclawPlugin (service + action + routes + view)
  types.ts                     Display DTOs + enum guards (resources, kinds, collections, periods)
  birdclaw/
    cli.ts                     execFile seam: BirdclawExec, runBirdclawJson/Text, typed BirdclawCliError
    service.ts                 BirdclawService + pure arg builders + wire parsers
    birdclaw.real.test.ts      REAL-CLI suite (gated; bun run test:real)
  actions/birdclaw.ts          BIRDCLAW umbrella action + formatters
  routes/birdclaw-routes.ts    status/tweets/inbox/sync/digest handlers
  components/birdclaw/
    BirdclawSpatialView.tsx    Presentational (snapshot + onAction, spatial primitives)
    BirdclawView.tsx           Data wrapper (fetcher seam, tab state machine, sync flow)
    birdclaw-view-bundle.ts    Vite bundle entry — re-exports BirdclawView
```

## Commands

```bash
bun run --cwd plugins/plugin-birdclaw typecheck
bun run --cwd plugins/plugin-birdclaw lint
bun run --cwd plugins/plugin-birdclaw test         # offline unit suite (fake exec seam)
bun run --cwd plugins/plugin-birdclaw test:real    # REAL birdclaw CLI against a temp BIRDCLAW_HOME
bun run --cwd plugins/plugin-birdclaw build        # build:js (tsup) + build:views (vite) + build:types (tsc)
```

## Config / env vars

| Variable | Default | Purpose |
|---|---|---|
| `BIRDCLAW_BIN` | `birdclaw` on PATH | Absolute path to the birdclaw CLI. |
| `BIRDCLAW_HOME` | CLI's own `~/.birdclaw` | Data root passed to every spawn. |
| `BIRDCLAW_OPENAI_API_KEY` | — | Forwarded to the CLI as `OPENAI_API_KEY` for its AI features (digest, inbox scoring). Never falls back to the agent's own key. |
| `ELIZA_BIRDCLAW` | auto-detect | `1/0` force-enables/disables plugin loading (collector gate). |

## Conventions / gotchas

- **Exit code is the only success signal.** birdclaw writes warnings (e.g.
  Node 22's `node:sqlite` ExperimentalWarning) to stderr on successful runs —
  never treat stderr output as failure.
- **`search tweets` returns a top-level JSON array; `inbox` returns
  `{ items }`.** The parsers narrow both to flat display DTOs and skip
  malformed rows (schema churn upstream is expected — "WIP. Real and usable").
- **The digest envelope is still settling upstream** — `digest()` accepts a
  JSON envelope (`digest`/`text`/`report` field) or raw markdown.
- **Timeouts:** reads 30s, sync/digest 120s. Sync runs synchronously in the
  route; the view disables the button while in flight.
- **No background poll in the view.** The archive only changes via
  sync/import, so the view reloads after its own syncs instead of polling.
- The view-bundle vite config must keep `codeSplitting: false` (shared config
  does this) — see the #11040 blank-view regression.
- See the root `AGENTS.md` for repo-wide conventions.

## ⛔ NON-NEGOTIABLE — evidence & real end-to-end tests

The binding standard is **[AGENTS.md](../../AGENTS.md)**. The unit
suite proves the arg-building/parsing/route/action/view logic against an
injected exec seam; `birdclaw.real.test.ts` (`bun run test:real`) drives the
REAL CLI — real spawn, real SQLite, real `--json` envelopes — against a
throwaway `BIRDCLAW_HOME` seeded by `birdclaw init`. UI changes additionally
require the rendered proof set (screenshots, walkthrough, client+server logs)
from `AGENTS.md`.
