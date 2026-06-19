# @elizaos/plugin-waifu-imagegen-app

Native **image-generation AppView** for waifu agents. Renders inside an agent's
ElizaOS web UI canvas (the apps overlay / desktop tab) and invokes the
waifu.fun image-gen mini-app endpoint directly, settled in Eliza Cloud credits.

Phase 1 of giving each waifu agent its own ElizaOS web UI: this replaces the
broken waifu patron panel with a first-class app-plugin view.

## What it ships

- **`ImageGenAppView.tsx`** — prompt input, aspect + model selectors, a
  credits/markup/model price strip, a generate button with loading state, typed
  error notices (401 sign-in / 402 insufficient-credits / 404 unavailable), and
  the resulting image with the settled charge. Built on `@elizaos/app-core`
  primitives (`PagePanel`, `Button`, `Spinner`) and `@elizaos/ui/agent-surface`
  (`useAgentElement`), matching the visual + agent-addressability language of
  `plugin-hyperliquid-app`.
- **`imagegen-client.ts`** — auth-aware `POST` to
  `/v2/agents/:token/apps/image-gen/invoke` on the waifu API. Sends the
  agent-app invoke key (`x-waifu-app-invoke-key`) when present, else a Steward
  JWT bearer. Maps HTTP status onto typed `ImageGenError`s.
- **`imagegen-config.ts`** — resolves the waifu API base, agent token, and auth
  credential from a host-injected `window.__WAIFU_IMAGEGEN__` global,
  `import.meta.env` (`VITE_WAIFU_*`), or a production default.
- **`imagegen-contracts.ts`** — standalone typed contract (aspects, models,
  prompt bounds, result + charge shapes, error classifier). No waifu-monorepo
  imports.
- **`plugin.ts`** — the `views` declaration (`waifu-imagegen`) that
  `plugin-app-manager` reads to discover + launch the view. Points at the
  third-partyized bundle (`dist/views/bundle.js`) and the `ImageGenAppView` export.

## Lazy + third-partyized

The overlay registration (`imagegen-app.ts`) loads the view via a dynamic
`import()`, and the view bundle third-partyizes `react`, `lucide-react`,
`@elizaos/ui`, and `@elizaos/app-core` (see `vite.config.views.ts`). The view's
component tree never lands in the main or mobile entry chunk.

## Configuration

Inject per-agent config when the shell mounts the view:

```ts
window.__WAIFU_IMAGEGEN__ = {
  apiBase: "https://waifu.fun",
  agentTokenAddress: "0x...",
  stewardJwt: "<jwt>",        // or appInvokeKey for trusted same-process hosts
  metadata: { inferenceMarkupPercentage: 100, model: "gpt-image-2" },
};
```

Or pass `agentTokenAddress` / `metadata` as props to `<ImageGenAppView>`.

## Build

```sh
bun run build        # js + view bundle + types
bun run build:views  # just the third-partyized view bundle
```
