# @elizaos/plugin-waifu-imagegen-app

Native **image-generation AppView** for waifu agents. A pure-frontend
app-plugin: it ships one GUI view (plus an XR variant) that renders inside an
agent's elizaOS web UI canvas (apps overlay / desktop tab) and invokes the
waifu.fun image-gen mini-app endpoint directly, settled in Eliza Cloud credits.

## Purpose / role

Gives a waifu agent a first-class image-generation surface in its elizaOS web
UI. Unlike `plugin-hyperliquid-app`, this plugin has **no agent
actions, services, or HTTP routes** — the backend already lives on the waifu
API. It contributes only a `views` declaration and an overlay-app registration;
everything else is a self-contained browser client.

## Plugin surface

### Actions / Services / Routes

None. This is a frontend-only AppView. The image-gen backend is the waifu.fun
API (`POST /v2/agents/:token/apps/image-gen/invoke`), reached by the in-view
client (`src/imagegen-client.ts`), not by an agent route.

### Views (registered in `src/plugin.ts`)
| id | viewType | Component |
|---|---|---|
| `waifu-imagegen` | default | `ImageGenAppView` |
| `waifu-imagegen` | `xr` | `ImageGenAppView` |

No `tui` view: the view is an interactive prompt/upload/preview form with a
generated `<img>`, not a read-only snapshot, so there is no terminal projection
to render. See the note in `src/register.ts`.

## Layout

```
src/
  index.ts                    Public package exports (incl. ./register)
  plugin.ts                   Plugin object: views only (no actions/services/routes)
  register.ts                 Side-effect: imports imagegen-app (registers overlay app)
  imagegen-app.ts             Overlay app definition + registerOverlayApp call
  imagegen-app-view-bundle.ts View bundle entry — re-exports ImageGenAppView
  imagegen-contracts.ts       Standalone typed contract: aspects, models, prompt
                              bounds, result/charge/error shapes + classifiers
  imagegen-config.ts          Resolve waifu API base / agent token / auth credential
  imagegen-client.ts          Auth-aware POST to the waifu invoke endpoint; maps
                              HTTP status onto typed ImageGenError
  useImageGenState.ts         React hook: prompt/aspect/model form + invoke lifecycle
  ui.ts                       Browser-only barrel (view + overlay app + hook)
  ImageGenAppView.tsx         React UI: ImageGenAppView (default + XR)
  ImageGenAppView.test.tsx    Render test (jsdom): shell, controls, generate, errors
__tests__/
  app-core-shim.ts            Test shim for @elizaos/app-core
  imagegen-contracts.test.ts  Pure-logic tests for classifiers / metadata readers
```

## Commands

```bash
bun run --cwd plugins/plugin-waifu-imagegen-app build        # tsup JS + vite views + tsc types
bun run --cwd plugins/plugin-waifu-imagegen-app build:js     # tsup only
bun run --cwd plugins/plugin-waifu-imagegen-app build:views  # third-partyized view bundle
bun run --cwd plugins/plugin-waifu-imagegen-app build:types  # tsc declarations
bun run --cwd plugins/plugin-waifu-imagegen-app test         # vitest run
bun run --cwd plugins/plugin-waifu-imagegen-app clean        # rm -rf dist
```

## Config / env vars

All resolved in `imagegen-config.ts::resolveWaifuImageGenConfig`. Sources, first
non-empty wins: host-injected `window.__WAIFU_IMAGEGEN__` global → `import.meta.env`
(`VITE_WAIFU_*`) → a production default (API base only). Or pass
`agentTokenAddress` / `metadata` as props to `<ImageGenAppView>` (props win).

| Source field / env var | Required | Description |
|---|---|---|
| `apiBase` / `VITE_WAIFU_API_BASE` | No | Waifu API base URL. Defaults to `https://waifu.fun`. |
| `agentTokenAddress` / `VITE_WAIFU_AGENT_TOKEN` | Yes¹ | Token address of the agent whose image-gen app is invoked. |
| `stewardJwt` / `VITE_WAIFU_STEWARD_JWT` | Yes² | Steward JWT bearer for a signed-in viewer. |
| `appInvokeKey` (injected global only) | Yes² | Agent-app invoke key (`x-waifu-app-invoke-key`). Trusted same-process hosts only. |
| `metadata` | No | App metadata bag (`inferenceMarkupPercentage`, `model`) for the price strip. |

¹ Without it the view renders a "no agent configured" notice and never invokes.
² One of `appInvokeKey` (preferred) or `stewardJwt` is required to invoke; the
client throws a typed `auth` error otherwise.

## How to extend

**Add an aspect / model option:** edit `IMAGE_GEN_ASPECTS` / `IMAGE_GEN_MODELS`
in `src/imagegen-contracts.ts`. The view renders option buttons from these
constants, so no view change is needed.

**Add a new view variant:** export the component from `src/ui.ts` and add a view
entry to `src/plugin.ts::views`. `vite.config.views.ts` builds the bundle.

## Conventions / gotchas

- **Frontend-only.** No agent actions/services/routes. Do not add a route here
  to reach the waifu API — invoke it from the in-view client, keyed by the
  agent token, the way `imagegen-client.ts` already does.
- **Clients display, never compute.** The price strip reads DTO fields
  (`charge.totalCost`, host `inferenceMarkupPercentage`) and formats them for
  display only. No fee/markup arithmetic happens in the view — keep it that way.
- **Secrets are host-injected.** `stewardJwt` / `appInvokeKey` arrive via the
  injected config or props and are only ever set as request headers. Never log
  them; never bake them into the bundle.
- **Auth precedence:** `x-waifu-app-invoke-key` (server/runtime) over
  `Authorization: Bearer <jwt>` (signed-in viewer). Mirrors the backend.
- **Typed errors:** `classifyImageGenStatus` maps HTTP status →
  `ImageGenError.kind` (`auth` / `insufficient-credits` / `not-available` /
  `duplicate` / `bad-request` / `misconfigured` / `unknown`). The view branches
  on `.kind`; a `not-available` (404) also fires the host `onUnavailable`.
- **Lazy + third-partyized.** The overlay registration (`imagegen-app.ts`)
  loads the view via dynamic `import()`, and the view bundle externalizes
  `react`, `lucide-react`, `@elizaos/ui`, and `@elizaos/app-core`
  (`vite.config.views.ts`). The view tree never lands in the main/mobile entry chunk.
- **Overlay app registration** (`src/imagegen-app.ts`) runs as a side effect
  when `src/register.ts` is imported; the package entrypoint re-exports
  `src/register.ts` so this is automatic on plugin load.
- **Test react resolution:** this plugin is not yet symlinked into the repo's
  `node_modules`, so `vitest.config.ts` anchors every `react` / `react-dom` /
  `lucide-react` alias at `@elizaos/ui` to avoid a mixed-react "Invalid hook
  call". Keep that anchoring if you touch the vitest config.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions,
  ESM/naming standards, and git workflow.
