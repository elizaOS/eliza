# @elizaos/plugin-waifu-swap-app

Native **token-swap AppView** for waifu agents. Renders inside an agent's
ElizaOS web UI canvas (the apps overlay / desktop tab) and drives the
**PancakeSwap v3** swap capability on the waifu.fun API.

Phase of giving each waifu agent its own ElizaOS web UI: this replaces the
broken waifu patron swap panel (`apps/frontend/src/components/agent-home/wave-t/swap-panel.tsx`)
with a first-class app-plugin view, modeled on `plugin-hyperliquid-app` and
`plugin-waifu-imagegen-app`.

## What it ships

- **`SwapAppView.tsx`** — token-in / token-out selectors, an amount input, a
  reverse-direction control, a live quote (expected out + minimum received),
  slippage presets, fee-tier selection, a route/price-impact detail strip, and a
  swap CTA. Built on `@elizaos/app-core` primitives (`PagePanel`, `Button`,
  `Spinner`) and `@elizaos/ui/agent-surface` (`useAgentElement`), matching the
  visual + agent-addressability language of `plugin-hyperliquid-app`.
- **`swap-client.ts`** — auth-aware `POST` to
  `/v2/agents/:token/capabilities/pancakeswap-v3/actions/:actionSlug` on the
  waifu API (the generic capability-action route). Sends the agent-app invoke
  key (`x-waifu-app-invoke-key`) when present, else a Steward JWT bearer. Maps
  HTTP status onto typed `SwapError`s.
- **`swap-config.ts`** — resolves the waifu API base, agent token, auth
  credential, and the swap-eligible token universe from a host-injected
  `window.__WAIFU_SWAP__` global, `import.meta.env` (`VITE_WAIFU_*`), or a
  production default. Always includes native BNB.
- **`swap-contracts.ts`** — standalone typed contract (capability/action slugs,
  fee tiers, slippage bounds, token + quote shapes, local quote estimator, error
  classifier). No waifu-monorepo imports. EVM `Address` defined locally.
- **`plugin.ts`** — the `views` declaration (`waifu-swap`) that
  `plugin-app-manager` reads to discover + launch the view. Points at the
  third-partyized bundle (`dist/views/bundle.js`) and the `SwapAppView` export.

## Display-only vs execute

This view is **quote-only** today.

- **Quote / display — fully built.** The displayed quote is a transparent local
  estimate (driven by per-token `priceBnb`), opportunistically upgraded with the
  backend `quote` (read mode) action. Because the backend's `pancakeswap-v3:quote`
  handler is **not yet registered** in the generic capability route's `HANDLERS`
  map (it returns `501 NOT_IMPLEMENTED`), the local estimate stays the display
  source until that lands; the client swallows the 501 and keeps the estimate.

- **Execute — intentionally stubbed (`SWAP_EXECUTE_TODO`).** The `swap` action is
  `agent_signed` + `requiresConsent`, and likewise has no backend handler yet
  (`501`). To avoid fabricating a money path, `executeSwap()` is gated behind
  `SWAP_EXECUTE_ENABLED = false`: a confirmed press surfaces a clear
  "execution not enabled yet" notice instead of POSTing to a route that can't
  fulfil it. The typed `prepareSwap()` client + unsigned-tx contract are wired
  and ready; flip `SWAP_EXECUTE_ENABLED` once the backend handler returns either
  an unsigned tx (client-signed, the user signs in their own wallet) or an
  agent-signer job, and the tx shape is confirmed.

**Follow-up to enable execution:** register `pancakeswap-v3:quote` and
`pancakeswap-v3:swap` handlers in
`apps/api/src/routes/v2/agents/capability-actions.ts` (`HANDLERS`), confirm the
unsigned-tx response shape, then flip `SWAP_EXECUTE_ENABLED` here.

## Lazy + third-partyized

The overlay registration (`swap-app.ts`) loads the view via a dynamic
`import()`, and the view bundle third-partyizes `react`, `lucide-react`,
`@elizaos/ui`, and `@elizaos/app-core` (see `vite.config.views.ts`). The view's
component tree never lands in the main or mobile entry chunk.

## Configuration

The host shell injects per-agent config when it mounts the view:

```ts
window.__WAIFU_SWAP__ = {
  apiBase: "https://waifu.fun",
  agentTokenAddress: "0x…",
  stewardJwt: "…",          // OR appInvokeKey for trusted server surfaces
  tokens: [                  // swap-eligible universe (BNB is always added)
    { address: "0x…", symbol: "SUKI", decimals: 18, priceBnb: 0.0001 },
  ],
};
```

Or via `import.meta.env`: `VITE_WAIFU_API_BASE`, `VITE_WAIFU_AGENT_TOKEN`,
`VITE_WAIFU_STEWARD_JWT`.
