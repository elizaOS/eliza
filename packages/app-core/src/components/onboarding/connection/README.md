# Connection onboarding screens

React components for the **`connection`** wizard step only. They do **not** decide wizard step order (`welcome` → `connection` → …); that stays in [`onboarding/flow.ts`](../../../onboarding/flow.ts). Shared types (`ConnectionEvent`, `ConnectionScreen`, …) live in [`onboarding/types.ts`](../../../onboarding/types.ts) and are re-exported from [`connection-flow.ts`](../../../onboarding/connection-flow.ts).

## Why this folder exists

The connection step had grown into one very large component with nested `if` trees. Splitting by **`ConnectionScreen`** (from [`connection-flow.ts`](../../../onboarding/connection-flow.ts)) gives:

- **Easier review** — change hosting or grid without scrolling through provider OAuth markup.
- **Clear boundary** — routing policy lives in the pure module; these files mostly render and call `dispatch` / context handlers.

## Files

| Component | Renders when `spec.screen` is |
|-----------|------------------------------|
| **`ConnectionUiRoot.tsx`** | Switches on `spec.screen` and mounts the matching screen. **Why a root:** one place to register a new screen when you add a `ConnectionScreen` variant. |
| **`ConnectionHostingScreen.tsx`** | `hosting` — local / remote / Eliza Cloud hosting cards. |
| **`ConnectionRemoteBackendScreen.tsx`** | `remoteBackend` — URL + token fields; back uses `backRemoteOrGrid` or `useLocalBackend` effect. |
| **`ConnectionElizaCloudPreProviderScreen.tsx`** | `elizaCloud_preProvider` — Eliza Cloud **before** the neural link (distinct from picking Eliza Cloud **as** the provider). **Why two Eliza UIs:** different footers, back targets, and copy. |
| **`ConnectionProviderGridScreen.tsx`** | `providerGrid` — neural link provider list. |
| **`ConnectionProviderDetailScreen.tsx`** | `providerDetail` — per-provider panels, API keys, subscription OAuth. |

## OAuth and local state

OpenAI redirect and Anthropic code-entry **`useState`** live on **`ConnectionProviderDetailScreen`**, not in `connection-flow.ts`. **Why:** the pure reducer must not call `client.*` or open browsers; those flows are effectful and UI-local.

**Tradeoff:** leaving detail (back to grid) **unmounts** this component, so in-progress OAuth UI resets. That matches “user left the detail flow”; if product ever needs to preserve OAuth across back, lift that state to `ConnectionStep` and pass props down.

## Dispatch

Parent passes `dispatch: (event: ConnectionEvent) => void` from `ConnectionStep`, which runs `applyConnectionTransition` and applies patches via `setState`. **Why not `useContext` for dispatch:** explicit props keep data flow obvious and avoid an extra provider for one step.

## Eliza Cloud OAuth auto-advance

[`useAdvanceOnboardingWhenElizaCloudOAuthConnected.ts`](./useAdvanceOnboardingWhenElizaCloudOAuthConnected.ts) calls **`handleOnboardingNext()`** once **`elizaCloudConnected`** is true on the **Login** tab. **Why:** avoids a redundant Confirm after the UI already shows “connected,” matching **`CloudLoginStep`**. **Why scoped to Login tab:** API-key mode still needs an explicit Confirm so we never advance on half-entered keys.

Used by **`ConnectionElizaCloudPreProviderScreen`** and **`ConnectionProviderDetailScreen`** (when `onboardingProvider === "elizacloud"`).

## Related

- Pure logic + transition table: [`connection-flow.ts`](../../../onboarding/connection-flow.ts)
- Shell wiring: [`../ConnectionStep.tsx`](../ConnectionStep.tsx)
- Guide: [docs/guides/onboarding-ui-flow.md](../../../../../docs/guides/onboarding-ui-flow.md)
