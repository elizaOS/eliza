# @elizaos/plugin-waifu-swap-app

Native **token-swap AppView** for waifu agents: a PancakeSwap v3 quote + slippage UI that renders inside an agent's elizaOS web UI canvas. **On-chain execution is hard-disabled** (`SWAP_EXECUTE_ENABLED = false`) — this is a quote-only preview.

## Purpose / role

A pure **frontend AppView** plugin — it ships a React view and an overlay-app registration, no agent routes/actions/services. The view drives the PancakeSwap v3 swap capability that lives on the **waifu.fun API** (a different origin from the elizaOS agent server), via the generic capability-action route. The displayed quote is a transparent **local estimate** (driven by per-token `priceBnb`), opportunistically upgraded with the backend `quote` (read-mode) action when one is available. Execution is intentionally stubbed until the backend handler + agent signer land.

## Plugin surface

### Views (registered in `src/plugin.ts`)
| id | viewType | Component | Path |
|---|---|---|---|
| `waifu-swap` | default | `SwapAppView` | `/waifu-swap` |
| `waifu-swap` | `xr` | `SwapAppView` | `/waifu-swap` |

No `tui` view: `SwapAppView` is an interactive form (token selectors, a numeric amount field, slippage/fee controls, a swap CTA) built on `@elizaos/app-core` + `@elizaos/ui/agent-surface`. It has no read-only snapshot shape that renders cleanly to terminal lines, so a TUI/terminal view is intentionally omitted (unlike the read-only `plugin-hyperliquid-app` dashboard).

No actions, services, or routes — the swap/quote backend already lives on the waifu API.

## Layout

```
src/
  index.ts                 Public package exports (re-exports ./register)
  plugin.ts                Plugin object: the `views` declaration only
  register.ts              Side-effect: imports swap-app (registers the overlay app). No terminal view.
  swap-app.ts              Overlay app definition + registerOverlayApp call (lazy view loader)
  swap-app-view-bundle.ts  Vite view-bundle entry (re-exports SwapAppView)
  swap-contracts.ts        Standalone typed contract: slugs, fee tiers, slippage bounds,
                           token + quote shapes, estimateLocalQuote, clampSlippage,
                           classifySwapStatus, SWAP_EXECUTE_ENABLED. No waifu-monorepo imports.
  swap-contracts.test.ts   Pure-logic tests (estimator, clamp, classifier, kill switch)
  swap-config.ts           Resolves apiBase / agent token / auth / token universe from the
                           injected window.__WAIFU_SWAP__ global, VITE_WAIFU_* env, or default
  swap-client.ts           Auth-aware POST to the waifu capability-action route; typed SwapError
  useSwapState.ts          React hook: token/amount/slippage/fee state, quote, guarded executeSwap
  SwapAppView.tsx          The React view (default + XR)
  SwapAppView.test.tsx     Render smoke test + disabled-execution safety assertion
  ui.ts                    Browser-only barrel (SwapAppView, swapApp, useSwapState)
__tests__/
  app-core-shim.ts         Test shim for @elizaos/app-core
```

## Commands

```bash
bun run --cwd plugins/plugin-waifu-swap-app build        # tsup JS + vite views + tsc types
bun run --cwd plugins/plugin-waifu-swap-app build:js     # tsup only
bun run --cwd plugins/plugin-waifu-swap-app build:views  # vite views bundle
bun run --cwd plugins/plugin-waifu-swap-app build:types  # tsc declarations
bun run --cwd plugins/plugin-waifu-swap-app test         # vitest run
bun run --cwd plugins/plugin-waifu-swap-app clean        # rm -rf dist
```

## Config / env vars

The host shell injects per-agent config when it mounts the view. Resolved in `src/swap-config.ts::resolveWaifuSwapConfig`, first non-empty wins: host-injected `window.__WAIFU_SWAP__` global → `import.meta.env` (`VITE_WAIFU_*`) → a production default for the API base.

| Source | Field | Description |
|---|---|---|
| `window.__WAIFU_SWAP__` / `VITE_WAIFU_API_BASE` | `apiBase` | waifu API base; the only outbound origin. Defaults to `https://waifu.fun`. |
| `window.__WAIFU_SWAP__` / `VITE_WAIFU_AGENT_TOKEN` | `agentTokenAddress` | The agent's id/token whose swap capability is invoked. Re-validated to a `0x`-prefixed 40-char address; otherwise `null`. |
| `window.__WAIFU_SWAP__` / `VITE_WAIFU_STEWARD_JWT` | `stewardJwt` | Bearer auth when the viewer is signed in. |
| `window.__WAIFU_SWAP__` | `appInvokeKey` | Agent-app invoke key (`x-waifu-app-invoke-key`) for trusted same-process surfaces. |
| `window.__WAIFU_SWAP__` | `tokens` | Swap-eligible token universe. Native BNB is always added exactly once. |

No private keys are handled. The view never holds or signs anything; even when execution lands, the `swap` action returns an **unsigned** tx the patron signs in their own wallet.

## Conventions / gotchas (safety)

- **On-chain execution is hard-disabled.** `SWAP_EXECUTE_ENABLED` (in `src/swap-contracts.ts`) is a compile-time `false as const`. `useSwapState::executeSwap()` reads it and short-circuits a confirmed press to an honest "not enabled yet" stub outcome — it never POSTs to the `swap` action. `swap-client.ts::prepareSwap()` is wired and typed but unreachable while the kill switch is off. Do **not** flip this without a server-side quoter, a confirmed unsigned-tx response shape, and a signer/consent path.
- **Slippage is clamped to `[0.01%, 50%]`.** `clampSlippage()` (`MIN_SLIPPAGE_PCT` / `MAX_SLIPPAGE_PCT`) bounds every slippage value; `useSwapState::setSlippagePct` and `estimateLocalQuote` both route through it. Non-finite input falls back to `DEFAULT_SLIPPAGE_PCT` (0.5%).
- **`estimateLocalQuote` is a CLIENT-SIDE PLACEHOLDER.** It derives output from per-token `priceBnb` with a bounded, monotonic price-impact model. This is acceptable **only because execution is disabled** — it is for display, not settlement. Before any future enablement, the quote must move server-side (the on-chain quoter), and `estimateLocalQuote` becomes a fallback-only estimate. There is a load-bearing comment to this effect in `swap-contracts.ts`.
- **Only one hardcoded address:** canonical WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` (`PANCAKE_V3_WBNB`), the native-asset proxy for PancakeSwap v3 routes. All other addresses come from injected/resolved config.
- **Outbound requests go only to the resolved `apiBase`** (default `https://waifu.fun`), to the generic capability-action route `POST /v2/agents/:token/capabilities/pancakeswap-v3/actions/:actionSlug`. Auth precedence: `x-waifu-app-invoke-key` header, else `Authorization: Bearer <stewardJwt>`. The opportunistic quote-upgrade probe is skipped entirely when no auth is present.
- **Backend handlers are not wired yet:** both `pancakeswap-v3:quote` and `:swap` currently return `501`. The client swallows the 501 on `quote` and keeps the local estimate; `swap` is never called (kill switch).
- **Overlay app registration** (`src/swap-app.ts`) happens as a side effect when `src/register.ts` is imported; the package entrypoint re-exports `./register` so it is automatic on plugin load.
- **Fast-Refresh split:** `SwapAppView.tsx` exports only React components; the hook lives in `useSwapState.ts` and the view-bundle entry in `swap-app-view-bundle.ts`. Keep it that way.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, ESM/naming standards, and git workflow.
