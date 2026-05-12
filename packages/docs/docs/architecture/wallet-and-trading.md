# Wallet and Trading Architecture

Status: canonical, gates implementation.
Owner: milady-feature-coordinator routes to specialists below.
Scope: this document defines the wallet abstraction, the action+provider surface, validation rules, audit + policy enforcement, the migration of existing key-bearing code, the surface coverage on desktop / cloud / mobile, and the dependency graph for execution.

The locked decisions in the brief are taken as inputs. This document does not relitigate them. It defines the contract that every implementation PR must satisfy.

---

## 0. Why this exists

Today, key handling is forked across at least four layers:

- `eliza/plugins/plugin-evm/typescript/providers/wallet.ts` reads `EVM_PRIVATE_KEY` directly via `runtime.getSetting`, autogenerates one when missing (lines 401-430), and persists it back into `runtime.character.settings.secrets` (lines 414-423).
- `eliza/plugins/plugin-solana/typescript/keypairUtils.ts` does the same for Solana (lines 21-35) and accepts both base58 and base64 (lines 51-61), branching twice for the same input shape.
- `eliza/packages/agent/src/api/wallet-routes.ts` exposes `POST /api/wallet/generate`, `POST /api/wallet/import`, and `POST /api/wallet/export` — the export endpoint (lines 1150-1183) hands plaintext keys to anyone who clears the rate limiter.
- `eliza/apps/app-steward/src/services/steward-evm-bridge.ts` injects a literal `0x0...001` placeholder key into the runtime (line 27, used at lines 56-57) so plugin-evm's autogen does not fire when Steward is meant to sign. That's a workaround, not a design.
- `eliza/packages/app-core/src/security/hydrate-wallet-keys-from-platform-store.ts` then hydrates `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, and three Steward env vars from the OS keychain (lines 10-16) — but only for "wallet" env vars, with no abstraction over the destination signer.

Each of these layers reads or writes keys with its own assumptions. Trading actions today inherit that mess: each venue plugin stitches together its own signer init path. The user wants a single canonical surface, and the architecture rules in `AGENTS.md` (deps inward, no polymorphism for runtime branching, no fallback sludge, no `any`) explicitly forbid the current shape.

This spec replaces all of it with one `WalletBackend` interface, two implementations, a small canonical action set, and per-venue providers.

---

## A. Wallet abstraction

### A.1 The interface

New file: `eliza/packages/agent/src/wallet/backend.ts`.

```ts
import type { Address, Hex, TypedDataDefinition } from "viem";
import type { Account as ViemAccount } from "viem/accounts";
import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

/**
 * Stable identity for a signing operation. Used by the audit log and the
 * policy module to bucket and authorize requests. `scope` distinguishes a
 * Hyperliquid `placeOrder` typed-data sig from an EVM `transferFrom` sig
 * even when both target the same chain. Format: "<provider>.<operation>".
 */
export type SignScope =
  | `hyperliquid.${string}`
  | `polymarket.${string}`
  | `lifi.${string}`
  | `aave.${string}`
  | `morpho.${string}`
  | `lp.${string}`
  | `transfer.${string}`
  | `automation.${string}`;

export interface SolanaSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction>;
  signAllTransactions(txs: Array<Transaction | VersionedTransaction>): Promise<Array<Transaction | VersionedTransaction>>;
}

export interface PendingApproval {
  readonly kind: "pending_approval";
  readonly approvalId: string;
  readonly scope: SignScope;
  readonly expiresAt: number; // epoch ms
  readonly summary: ApprovalSummary;
}

export interface ApprovalSummary {
  readonly title: string;            // "Open BTC perp 1x" — for the tray + chat surface
  readonly venue: string;            // "hyperliquid"
  readonly chainHint: "evm" | "solana" | "off-chain";
  readonly fields: ReadonlyArray<{ label: string; value: string }>;
}

export interface SignaturePayload {
  readonly kind: "signature";
  readonly signature: Hex;
  readonly raw?: Hex; // raw signed tx if backend signed full tx
}

export type SignResult = SignaturePayload | PendingApproval;

export interface WalletAddresses {
  readonly evm: Address;
  readonly solana: PublicKey;
}

export type WalletBackendKind = "local" | "steward";

export interface WalletBackend {
  readonly kind: WalletBackendKind;

  /** Live, user-facing addresses — must be available synchronously after init. */
  getAddresses(): WalletAddresses;

  /**
   * Returns a viem `Account` bound to `chainId`. For local backends this is a
   * `PrivateKeyAccount`; for Steward this is a custom `Account` whose
   * `signMessage`/`signTypedData`/`signTransaction` route through the vault
   * and may throw `PendingApprovalError`.
   */
  getEvmAccount(chainId: number): ViemAccount;

  /** Solana signer, same pattern. */
  getSolanaSigner(): SolanaSigner;

  /**
   * Sign an arbitrary message. Used by venues that authenticate via signed
   * messages (Hyperliquid agent registration, Polymarket order envelopes).
   */
  signMessage(scope: SignScope, message: Hex): Promise<SignResult>;

  /** EIP-712 typed-data signing. */
  signTypedData(scope: SignScope, typedData: TypedDataDefinition): Promise<SignResult>;
}

export class PendingApprovalError extends Error {
  readonly kind = "pending_approval" as const;
  constructor(readonly pending: PendingApproval) {
    super(`Wallet operation pending approval: ${pending.scope} (${pending.approvalId})`);
    this.name = "PendingApprovalError";
  }
}
```

The interface is intentionally narrow: read addresses, return signers, and sign in the two formats venues actually need. No "balance" methods on the backend — balances are read by the `wallet` provider, which talks to RPC, not to the keystore.

### A.2 LocalEoaBackend

New file: `eliza/packages/agent/src/wallet/local-eoa-backend.ts`.

Inputs (env, in order of precedence):

1. `EVM_PRIVATE_KEY` (32-byte hex, 0x-prefixed, validated by viem's `PrivateKeySchema` — already used at `eliza/plugins/plugin-evm/typescript/providers/wallet.ts:235`).
2. `SOLANA_PRIVATE_KEY` (base58 only — base64 fallback in `keypairUtils.ts:55-58` is removed; one canonical encoding).
3. Hydration from the OS keychain via the existing `hydrateWalletKeysFromNodePlatformSecureStore()` function in `eliza/packages/app-core/src/security/hydrate-wallet-keys-from-platform-store.ts`, called once at boot before backend construction. That function stays as-is.

**Autogen-on-first-run rule: NO.** The current behavior in `plugin-evm/typescript/providers/wallet.ts:401-430` and `plugin-solana/typescript/keypairUtils.ts:21-35` silently mints a wallet and persists it. That collides with three architecture rules:

- "No fallback sludge that hides a missing pipeline" (AGENTS.md §What to remove on sight). Auto-creating a key when one is missing is exactly the pattern the spec calls out.
- "Every endpoint needs a client trigger" — the user is the trigger for wallet creation, not a runtime side effect.
- "Explicit failure over ambiguous success" — silent mint plus warning logs is ambiguous success.

`LocalEoaBackend.init()` must instead throw `WalletBackendNotConfiguredError` with `code: "EVM_PRIVATE_KEY_MISSING"` or `"SOLANA_PRIVATE_KEY_MISSING"`. The desktop UI handles the case explicitly via `POST /api/wallet/generate` (which the user clicks), and `bun run dev` prints a clear setup banner if no key is found. This makes wallet creation a deliberate operator action observable in the audit log.

`LocalEoaBackend.signMessage` and `.signTypedData` always return a `SignaturePayload`. They never return `PendingApproval` — local mode is opt-in for the operator; the policy module (§F.3) still enforces soft-limits and may refuse pre-sign, but it never queues for human approval because there is no second human. Refusal surfaces as a typed validate-failure, not a pending state.

### A.3 StewardBackend

New file: `eliza/packages/agent/src/wallet/steward-backend.ts`.

Inputs (env): `STEWARD_API_URL`, `STEWARD_AGENT_ID`, `STEWARD_AGENT_TOKEN`, `STEWARD_TENANT_ID`, `STEWARD_API_KEY`, `MILADY_CLOUD_CLIENT_ADDRESS_KEY`. Resolution mirrors the existing `resolveEffectiveStewardConfig` in `eliza/apps/app-steward/src/services/steward-wallet.ts:75-99`.

Sidecar lifecycle:

- In **Eliza Cloud (web)** the Steward API runs as a multi-tenant service; the sidecar at `eliza/apps/app-steward/src/services/steward-sidecar.ts` is **not** spawned — `STEWARD_API_URL` points at the managed service.
- In **mobile (Capacitor)** there is no sidecar at all; the app is cloud-routed directly.
- In **desktop**, `LocalEoaBackend` is the default; `StewardBackend` only activates if the user explicitly opts into managed signing (`MILADY_WALLET_BACKEND=steward`). When it does, the sidecar at `eliza/apps/app-steward/src/services/steward-sidecar.ts` boots Steward as a child process (already implemented). This is a power-user setup, not the default.

Approval queue subscription: `StewardBackend` listens via webhook (`eliza/apps/app-steward/src/routes/steward-bridge.ts` already wires `registerStewardWebhook` and `getRecentWebhookEvents`). When a `signMessage` / `signTypedData` call returns Steward's `pending: true` / `approved: false` shape (see `StewardSignResponse` at `eliza/apps/app-steward/src/types/steward.ts:111-118`), the backend yields a `PendingApproval` whose `approvalId` is the `txId`. The action handler observing this is responsible for surfacing it (§A.4).

Fallback behavior when Steward is unreachable: **fail loud, not silent.** Throw `StewardUnavailableError` with the underlying network reason. No falling back to a local EOA — that would silently move funds from a backend the user did not consent to. The current code in `wallet-routes.ts:724-730` ("Steward wallet generation failed, falling back to local") **must be removed** as part of the migration.

### A.4 PendingApproval observation

When an action handler catches `PendingApprovalError`, it does four things in this exact order:

1. **Persist**: write a row to `audit_log` with `kind: "approval_requested"`, the `SignScope`, the `ApprovalSummary`, and the `approvalId`.
2. **Reply**: return a structured action result with `state: "pending_approval"` and the summary. The chat surface renders this as an inline approve/reject card.
3. **Notify**:
   - Desktop: increment the tray badge (already wired in `eliza/apps/app-steward/src/ApprovalQueue.tsx`, polling every 10s — this stays).
   - Cloud (web): server-sent event on `/api/wallet/approvals/stream` — new endpoint defined in §H.2.
   - Mobile: forwarded over the same SSE stream; the Capacitor JS bridge subscribes and posts a native notification.
4. **Subscribe**: the action handler does not block on the approval. The webhook handler (`registerStewardWebhook`) emits `approval.resolved` on the runtime event bus; an automation listener picks it up and re-invokes the originating action with `resumeFromApprovalId`.

The "approval queue badge" wiring is already most of the way there. The new work is the SSE endpoint and the resume path. The **resume path is the only place** where an action can be re-run against a stored intent — this is not a generic re-invocation surface.

### A.5 Runtime selection

`MILADY_WALLET_BACKEND=local|steward|auto` (default `auto`).

Selection table:

| platform | env value | resolved backend |
|----------|-----------|------------------|
| desktop  | `auto` (default) | `local` |
| desktop  | `local`   | `local` |
| desktop  | `steward` | `steward` (with sidecar) |
| cloud    | `auto`    | `steward` (managed) |
| cloud    | `local`   | rejected at boot — cloud cannot host plaintext keys |
| mobile   | `auto`    | `steward` (managed) |
| mobile   | `local`   | rejected at boot |

Resolution lives in `eliza/packages/agent/src/wallet/select-backend.ts` and is called exactly once during runtime init, before plugins load. The result is registered as a runtime service under `WalletBackendService` so providers and actions reach it through `runtime.getService("wallet-backend")`. No plugin reads env vars for keys directly anymore.

---

## B. Action + provider pattern

### B.1 Canonical action shape

```ts
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { z } from "zod";

export interface CanonicalActionDefinition<Schema extends z.ZodTypeAny> {
  name: string;
  description: string;
  similes: ReadonlyArray<string>;
  schema: Schema;
  validate(
    runtime: IAgentRuntime,
    message: Memory,
    params: z.infer<Schema>,
  ): Promise<ValidateOutcome>;
  handler(
    runtime: IAgentRuntime,
    message: Memory,
    params: z.infer<Schema>,
  ): Promise<ActionResult>;
  examples: ReadonlyArray<ActionExample>;
}

export type ValidateOutcome =
  | { ok: true }
  | { ok: false; reason: ValidateFailureCode; detail: string };

export type ActionResult =
  | { ok: true; data: unknown; receipts?: ReadonlyArray<Receipt> }
  | { ok: false; error: ActionFailureCode; detail: string }
  | { ok: false; error: "PENDING_APPROVAL"; pending: PendingApproval };
```

Adapt `Action` from elizaOS core to surface this shape. The wrapper `defineCanonicalAction` lives at `eliza/packages/agent/src/actions/define.ts` and emits a real `Action` the runtime registers. Zod parse + validate run inside `validate()`; the handler trusts `params` is already the parsed shape (single source of truth — AGENTS.md §7).

Examples are **typed**, not free-form text — they map an English prompt to the exact `params` the planner should produce. This is what auto.fun's prompt catalog feeds into.

### B.2 Validate gate — strict order

`validate()` runs these six checks in this order. Each check returns a typed `ValidateFailureCode`:

1. **Zod parse** — `schema.safeParse(params)`. Failure: `INVALID_PARAMS` with the zod issue path.
2. **Feature flag / plugin enabled** — `runtime.isPluginEnabled("@elizaos/plugin-hyperliquid")`. Failure: `PLUGIN_DISABLED`.
3. **Provider availability + auth** — `runtime.getProvider(name).healthcheck()`. Failure: `PROVIDER_UNAVAILABLE` or `PROVIDER_AUTH_MISSING`.
4. **Wallet capability** — `runtime.getService("wallet-backend").canSign(chainHintFor(params))`. Local EOA on a chain it has a key for, or Steward agent that owns this venue. Failure: `WALLET_NOT_AVAILABLE` or `VENUE_NOT_SUPPORTED_ON_BACKEND`.
5. **Policy** — `policyModule.evaluate(scope, summary)`. Failure: `POLICY_REQUIRES_APPROVAL` (Steward) or `POLICY_BLOCKED` (local soft-limit). For Steward, an auto-approve threshold met means policy returns `ok`; below threshold returns `requires_approval` and the action becomes `PENDING_APPROVAL` only after the handler attempts to sign.
6. **Preconditions** — `provider.preflight(params)`. Sufficient balance, market open, instrument exists, leverage in range. Failure: `INSUFFICIENT_BALANCE`, `MARKET_CLOSED`, `INSTRUMENT_NOT_FOUND`, `LEVERAGE_OUT_OF_RANGE`, `SLIPPAGE_EXCEEDED`.

Critical: validate is **read-only**. It must not mutate state, must not place orders, must not advance approvals. Handlers handle. (CQRS — AGENTS.md §6.)

### B.3 Provider interface

New file: `eliza/packages/agent/src/providers/provider.ts`.

```ts
export interface CanonicalProvider {
  readonly name: string;
  readonly contextBudgetTokens: number;

  /** Injected into the planner prompt. Read-only summary of provider state. */
  getContext(runtime: IAgentRuntime, message: Memory): Promise<ProviderContextResult>;

  /** Cheap, non-stateful check used by validate(). */
  healthcheck(runtime: IAgentRuntime): Promise<HealthStatus>;
}
```

Each provider then exposes its **typed methods** — these are the things actions call. They are **not** part of `CanonicalProvider`; they live on the concrete class:

```ts
class HyperliquidProvider implements CanonicalProvider {
  async openPerp(input: HyperliquidOpenPerpInput): Promise<HyperliquidOrderReceipt> { ... }
  async closePerp(input: HyperliquidCloseInput): Promise<HyperliquidOrderReceipt> { ... }
  async getMarket(symbol: string): Promise<HyperliquidMarket> { ... }
  // ...
}
```

Actions retrieve the concrete provider via a typed registry: `runtime.getProvider<HyperliquidProvider>("hyperliquid")`. The registry is strongly typed — see §B.5.

Providers do NOT register actions directly with the planner. Only canonical actions (see §C) are registered. This is the key architectural rule: **the planner sees ten verbs, period.** Adding a new venue means adding a provider, not a new action.

### B.4 Provider context budget

Total per-turn provider context budget: **2,000 tokens**. Each provider declares `contextBudgetTokens`. The runtime injects providers into the planner prompt in this priority order, dropping any whose cumulative count exceeds the budget:

1. `wallet` (200) — addresses, balances. Always included.
2. `automation` (150) — active rules, recent triggers. Always included.
3. Venue providers ranked by recency of mention in the last 5 messages: `hyperliquid` / `polymarket` / `aave` / `morpho` / `lp-evm` (300 each).
4. Market data providers: `coingecko` (200), `defillama` (200), `news` (250), `sentiment` (150), `charts` (250).
5. `lifi` (100) — only included if the planner's recent intent matches `swap` or `bridge`.

When the budget is exceeded, lower-priority providers drop entirely (no truncation, no partial). The dropped list is exposed in the trace for debugging.

### B.5 File layout

Recommended layout (concrete):

```
eliza/packages/agent/src/
  wallet/
    backend.ts                    # WalletBackend interface
    local-eoa-backend.ts          # LocalEoaBackend impl
    steward-backend.ts            # StewardBackend impl
    select-backend.ts             # runtime selection
    pending-approval.ts           # PendingApproval, errors, audit hooks
  policy/
    policy.ts                     # PolicyModule interface
    local-policy.ts               # in-process policy for local EOA mode
    steward-policy-bridge.ts      # delegates to Steward server-side rules
  providers/
    provider.ts                   # CanonicalProvider interface
    registry.ts                   # typed registry
    coingecko/
    defillama/
    news/
    sentiment/
    charts/
    lifi/
    hyperliquid/
    polymarket/
    aave/
    morpho/
    lp-evm/
    wallet/
    automation/
  actions/
    define.ts                     # defineCanonicalAction
    trade.ts                      # TRADE
    manage-position.ts            # MANAGE_POSITION
    query-market.ts               # QUERY_MARKET
    query-portfolio.ts            # QUERY_PORTFOLIO
    lend.ts                       # LEND
    manage-lp.ts                  # MANAGE_LP
    transfer.ts                   # TRANSFER
    set-automation.ts             # SET_AUTOMATION
    manage-automation.ts          # MANAGE_AUTOMATION
    failure-codes.ts              # ValidateFailureCode + ActionFailureCode unions
  audit/
    audit-log.ts                  # see §F
```

Tradeoff considered, decision made: centralize canonical actions in `packages/agent/src/actions/`. Rejected alternative: per-plugin actions (e.g. `plugin-hyperliquid` ships its own `HYPERLIQUID_PERP_OPEN` action). The user's intent is one canonical surface; per-plugin actions would re-introduce N parallel verbs. The cost is that adding a new venue requires editing `trade.ts` to wire it into the dispatch — but that edit is a single line in a switch on `venue`, not new planner-visible surface area, so the tradeoff is correct.

### B.6 Sharp edges to call out

- **Discriminated unions on `kind` collapse to the wrong dispatch when adding "spot perp on Polymarket" or similar cross-venue products.** Mitigation: `kind` is the financial primitive (perp / spot / prediction / swap / bridge), `venue` is the rail. They are independent in the schema; the dispatcher refuses unsupported `(kind, venue)` pairs at validate-time with `VENUE_NOT_SUPPORTED_FOR_KIND`.
- **`MANAGE_POSITION` and `TRANSFER` are tempting to merge** ("close perp" sends value, "transfer" sends value). They stay separate because the policy boundary is different: `TRANSFER` to an external address triggers withdrawal-policy rules; closing a position settles back into the same vault.
- **`SET_AUTOMATION` overlaps with `TRADE` when the rule fires immediately.** Resolution: `SET_AUTOMATION` always returns an automation receipt; the firing path goes through the automation runner which then invokes `TRADE` internally. Two distinct planner verbs, one execution path.

---

## C. Canonical action specs

For every action: schema, validate pseudocode, dispatch, and example mapping. Code samples are illustrative — implementers must keep them in sync with the actual provider method signatures.

### C.1 TRADE

```ts
const TradeInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("perp"),
    venue: z.literal("hyperliquid"),
    instrument: z.string().regex(/^[A-Z]{2,10}-USD$/),
    side: z.enum(["long", "short"]),
    sizeUsd: z.number().positive(),
    leverage: z.number().min(1).max(50),
    stopLossPct: z.number().min(0).max(100).optional(),
    takeProfitPct: z.number().min(0).max(1000).optional(),
    reduceOnly: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("spot"),
    venue: z.enum(["lifi"]),
    fromToken: TokenRefSchema,
    toToken: TokenRefSchema,
    amount: AmountSchema,           // { kind: "exact-in" | "exact-out", value: string }
    slippageBps: z.number().int().min(1).max(2000).default(50),
  }),
  z.object({
    kind: z.literal("prediction"),
    venue: z.literal("polymarket"),
    marketId: z.string().min(8),
    outcome: z.string().min(1),     // "YES" | "NO" | named outcome
    side: z.enum(["buy", "sell"]),
    sizeUsdc: z.number().positive(),
    limitPrice: z.number().min(0.01).max(0.99).optional(),
  }),
  z.object({
    kind: z.literal("swap"),
    fromToken: TokenRefSchema,
    toToken: TokenRefSchema,
    amount: AmountSchema,
    slippageBps: z.number().int().min(1).max(2000).default(50),
    // venue intentionally absent — Li.Fi routes
  }),
  z.object({
    kind: z.literal("bridge"),
    fromChain: ChainIdSchema,
    toChain: ChainIdSchema,
    token: TokenRefSchema,
    amount: AmountSchema,
    slippageBps: z.number().int().min(1).max(5000).default(100),
  }),
]);
```

`validate()` pseudocode:

```ts
async validate(runtime, message, params) {
  const parsed = TradeInputSchema.safeParse(params);
  if (!parsed.success) return fail("INVALID_PARAMS", parsed.error.message);

  const provider = providerFor(parsed.data);
  if (!runtime.isPluginEnabled(provider.pluginId)) return fail("PLUGIN_DISABLED", provider.pluginId);

  const health = await provider.healthcheck(runtime);
  if (!health.ok) return fail("PROVIDER_UNAVAILABLE", health.reason);

  const wallet = runtime.getService<WalletBackendService>("wallet-backend");
  if (!wallet.canSign(chainHintFor(parsed.data))) return fail("VENUE_NOT_SUPPORTED_ON_BACKEND", ...);

  const policy = await policyModule.evaluate(scopeFor(parsed.data), summaryFor(parsed.data));
  if (policy.kind === "blocked") return fail("POLICY_BLOCKED", policy.reason);

  const pre = await provider.preflight(runtime, parsed.data);
  if (!pre.ok) return fail(pre.code, pre.detail);

  return { ok: true };
}
```

`handler()` dispatch:

```ts
async handler(runtime, message, params) {
  const provider = providerFor(params);
  switch (params.kind) {
    case "perp":       return await (provider as HyperliquidProvider).openPerp(params);
    case "spot":       return await (provider as LifiProvider).swap(params);
    case "prediction": return await (provider as PolymarketProvider).placeOrder(params);
    case "swap":       return await (provider as LifiProvider).swap(params);
    case "bridge":     return await (provider as LifiProvider).bridge(params);
  }
}
```

(`spot` and `swap` look the same here — they are. `spot` exists as a planner verb because some prompts say "buy SOL" without specifying chain; the planner emits `kind: "spot"` and Li.Fi routes. `swap` is the cross-token, intent-specific verb that lets the planner request a specific source token.)

Example mapping from auto.fun's prompts:

| English | params |
|---------|--------|
| "Long BTC at 1x" | `{kind:"perp",venue:"hyperliquid",instrument:"BTC-USD",side:"long",sizeUsd:<balance>,leverage:1}` |
| "Short ETH 5x with a 5% stop" | `{kind:"perp",venue:"hyperliquid",instrument:"ETH-USD",side:"short",sizeUsd:<balance>,leverage:5,stopLossPct:5}` |
| "Buy YES on the Trump election market for $50" | `{kind:"prediction",venue:"polymarket",marketId:<resolved>,outcome:"YES",side:"buy",sizeUsdc:50}` |
| "Swap 100 USDC to ETH on Base" | `{kind:"swap",fromToken:{chain:"base",symbol:"USDC"},toToken:{chain:"base",symbol:"ETH"},amount:{kind:"exact-in",value:"100"}}` |
| "Bridge 1 ETH from Arbitrum to Base" | `{kind:"bridge",fromChain:42161,toChain:8453,token:{symbol:"ETH"},amount:{kind:"exact-in",value:"1"}}` |

### C.2 MANAGE_POSITION

```ts
const ManagePositionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("close"),
    venue: z.enum(["hyperliquid", "polymarket"]),
    positionId: z.string(),
    size: z.union([z.literal("all"), z.number().positive()]).default("all"),
  }),
  z.object({
    kind: z.literal("modify"),
    venue: z.literal("hyperliquid"),
    positionId: z.string(),
    stopLossPct: z.number().min(0).max(100).optional(),
    takeProfitPct: z.number().min(0).max(1000).optional(),
    leverage: z.number().min(1).max(50).optional(),
  }),
  z.object({
    kind: z.literal("cancel"),
    venue: z.enum(["hyperliquid", "polymarket"]),
    orderId: z.string(),
  }),
]);
```

Dispatches to `hyperliquid.closePosition`, `hyperliquid.modifyPosition`, `hyperliquid.cancelOrder`, `polymarket.cancelOrder`.

### C.3 QUERY_MARKET (read-only, no wallet check)

```ts
const QueryMarketSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price"), instrument: z.string(), venue: z.enum(["hyperliquid","polymarket","coingecko"]).default("coingecko") }),
  z.object({ kind: z.literal("chart"), instrument: z.string(), timeframe: z.enum(["1h","4h","1d","1w"]).default("1d") }),
  z.object({ kind: z.literal("sentiment"), query: z.string() }),
  z.object({ kind: z.literal("news"), query: z.string(), since: z.string().datetime().optional() }),
  z.object({ kind: z.literal("depth"), instrument: z.string(), venue: z.enum(["hyperliquid","polymarket"]) }),
  z.object({ kind: z.literal("funding"), instrument: z.string(), venue: z.literal("hyperliquid") }),
]);
```

`validate()` skips checks 4 and 5 (no wallet, no policy) — read-only. `handler()` dispatches to the appropriate read provider. This is the only canonical action that runs without a wallet.

### C.4 QUERY_PORTFOLIO

```ts
const QueryPortfolioSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("balances"), chain: z.enum(["evm","solana","all"]).default("all") }),
  z.object({ kind: z.literal("positions"), venue: z.enum(["hyperliquid","polymarket","aave","morpho","lp-evm","all"]).default("all") }),
  z.object({ kind: z.literal("pnl"), venue: z.enum(["hyperliquid","polymarket","all"]).default("all"), window: z.enum(["24h","7d","30d","all"]).default("7d") }),
  z.object({ kind: z.literal("history"), venue: z.enum(["hyperliquid","polymarket","aave","morpho","lp-evm","transfers","all"]).default("all"), limit: z.number().int().min(1).max(500).default(50) }),
]);
```

Dispatches to `wallet.getBalances`, `<venue>.getPositions`, `<venue>.getPnL`, `<venue>.getHistory`. No signing — wallet check is `canRead`, not `canSign`.

### C.5 LEND

```ts
const LendSchema = z.object({
  kind: z.enum(["supply","borrow","repay","withdraw"]),
  protocol: z.enum(["aave","morpho","auto"]).default("auto"),
  chain: ChainIdSchema,
  asset: TokenRefSchema,
  amount: AmountSchema,
  collateralAsset: TokenRefSchema.optional(),  // borrow only
  rateMode: z.enum(["variable","fixed"]).optional(),
});
```

`protocol: "auto"` resolves at validate-time by querying both providers' yield endpoints and picking the better rate; the resolved protocol is recorded in the audit summary so the user sees what executed.

### C.6 MANAGE_LP

```ts
const ManageLpSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open"),
    chain: ChainIdSchema,
    pool: z.string(),                  // pool address or known-pool ref
    token0Amount: AmountSchema,
    token1Amount: AmountSchema,
    rangeLowerPct: z.number().min(-99).max(0),
    rangeUpperPct: z.number().min(0).max(10000),
  }),
  z.object({ kind: z.literal("close"), positionId: z.string() }),
  z.object({ kind: z.literal("collect"), positionId: z.string() }),
  z.object({
    kind: z.literal("rebalance"),
    positionId: z.string(),
    rangeLowerPct: z.number().min(-99).max(0),
    rangeUpperPct: z.number().min(0).max(10000),
  }),
]);
```

Dispatches to `lp-evm.openPosition`, `lp-evm.closePosition`, `lp-evm.collect`, `lp-evm.rebalance`.

### C.7 TRANSFER

```ts
const TransferSchema = z.discriminatedUnion("chain", [
  z.object({
    chain: z.literal("evm"),
    chainId: ChainIdSchema,
    token: TokenRefSchema,
    to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    amount: AmountSchema,
    memo: z.string().max(140).optional(),
  }),
  z.object({
    chain: z.literal("solana"),
    token: TokenRefSchema,
    to: z.string().min(32).max(44), // base58 pubkey length range
    amount: AmountSchema,
    memo: z.string().max(140).optional(),
  }),
]);
```

Always triggers withdrawal-policy evaluation in `policyModule` regardless of size — `TRANSFER` is the only action that moves value to an arbitrary external address. Withdrawal allowlist (per-user) is checked in step 5 of validate.

### C.8 SET_AUTOMATION

```ts
const SetAutomationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dca"),
    intent: TradeInputSchema,                // reuse: an automation IS a deferred trade
    schedule: z.discriminatedUnion("type", [
      z.object({ type: z.literal("cron"), cron: z.string() }),
      z.object({ type: z.literal("interval"), seconds: z.number().int().min(60) }),
    ]),
    until: z.string().datetime().optional(),
    maxRuns: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("threshold"),
    intent: TradeInputSchema,
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("price"), instrument: z.string(), op: z.enum(["lt","gt"]), value: z.number() }),
      z.object({ kind: z.literal("pnl"), positionId: z.string(), op: z.enum(["lt","gt"]), valueUsd: z.number() }),
    ]),
    expiresAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal("pnl-exit"),
    positionId: z.string(),
    stopLossUsd: z.number().optional(),
    takeProfitUsd: z.number().optional(),
  }),
]);
```

`SetAutomationSchema` reuses `TradeInputSchema` as the intent payload — automations are deferred trades. The automation runner re-uses the `TRADE` validate path when firing, so a stale automation that newly fails validate (e.g. balance dropped) surfaces a typed failure rather than silent skip.

### C.9 MANAGE_AUTOMATION

```ts
const ManageAutomationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), status: z.enum(["active","paused","completed","all"]).default("active") }),
  z.object({ kind: z.literal("pause"), automationId: z.string() }),
  z.object({ kind: z.literal("resume"), automationId: z.string() }),
  z.object({ kind: z.literal("delete"), automationId: z.string() }),
]);
```

---

## D. Provider specs

For each provider: read methods, write methods (where applicable), env vars, dependencies, consuming actions.

### D.1 `coingecko`

- Source: lift from `/tmp/otaku-review-2026-04-29` (`plugin-coingecko`). Re-shape into provider form, strip `any`, add zod for inputs.
- Env: `COINGECKO_API_KEY` (optional — works on free tier with rate-limit risk).
- Read: `getPrice(symbol)`, `getMarketChart(symbol, timeframe)`, `searchToken(query)`.
- Consumed by: `QUERY_MARKET` (price, chart).

### D.2 `defillama`

- Source: lift from `/tmp/otaku-review-2026-04-29` (`plugin-defillama`).
- Env: none (public API).
- Read: `getProtocolTvl(slug)`, `getYields({ chain, asset })`, `getPoolApys(poolIds)`.
- Consumed by: `QUERY_MARKET` (depth-adjacent), `LEND` (auto-protocol selection).

### D.3 `news`

- Source: lift from `/tmp/otaku-review-2026-04-29` (`plugin-web-search` for Tavily, plus the CoinDesk RSS adapter from otaku).
- Env: `TAVILY_API_KEY` for general crypto news; CoinDesk uses public RSS.
- Read: `searchCryptoNews(query, since?)`, `getCoinDeskHeadlines(limit)`.
- Consumed by: `QUERY_MARKET` (news).

### D.4 `sentiment`

- Source: new — but reuses Twitter/X infra Milady already has via the Telegram-style platform connectors. If no X SDK is in-tree, depend on `@elizaos/plugin-x` (lowercase scope per CLAUDE.md naming rules).
- Env: `X_BEARER_TOKEN` (or whatever the official elizaOS X plugin requires).
- Read: `getSentiment(query)` returns `{ score: -1..1, sampleCount: number, topPosts: Array<{ id, text, author, ts }> }`.
- Consumed by: `QUERY_MARKET` (sentiment).

### D.5 `charts`

- Provider that renders price charts. Returns an image URL (signed Eliza Cloud asset URL) plus a structured candle series.
- Backed by CoinGecko + Hyperliquid candle endpoints.
- Read: `renderChart({ instrument, timeframe })`.
- Consumed by: `QUERY_MARKET` (chart).

### D.6 `lifi`

- Source: `@lifi/sdk` (npm).
- Env: none.
- Read: `getRoutes(input)`, `getStatus(txHash)`.
- Write: `swap(input): Promise<SwapReceipt>`, `bridge(input): Promise<BridgeReceipt>` — internally constructs the route, hands the resulting tx to `WalletBackend.getEvmAccount(chainId)`.
- Consumed by: `TRADE` (kind=`swap`, `bridge`, `spot`).
- The agent never sees specific DEX names — Li.Fi handles routing internally. (User requirement: "agent never sees specific DEX names.")

### D.7 `hyperliquid`

- Source: `@nktkas/hyperliquid` (or whichever official SDK; spec author leaves the exact pin to implementation).
- Env: `HYPERLIQUID_AGENT_KEY` (optional — for Hyperliquid's own agent-key delegation; if absent, falls back to direct EOA signing). Live mainnet only — no testnet.
- Read: `getMarket(symbol)`, `getOrderbook(symbol)`, `getFunding(symbol)`, `getPositions()`, `getOpenOrders()`, `getPnL(window)`, `getHistory(limit)`.
- Write: `openPerp(input)`, `closePosition(input)`, `modifyPosition(input)`, `cancelOrder(input)` — internally signs with `WalletBackend.signTypedData("hyperliquid.placeOrder", ...)`.
- Consumed by: `TRADE` (kind=`perp`), `MANAGE_POSITION`, `QUERY_PORTFOLIO`, `QUERY_MARKET`.

### D.8 `polymarket`

- Source: lift from `/tmp/otaku-review-2026-04-29` (`plugin-polymarket-discovery`). Add place-orders capability per locked decision.
- Env: `POLYMARKET_API_KEY` (CLOB API), `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`.
- Read: `searchMarkets(query)`, `getMarket(marketId)`, `getOrderbook(marketId, outcome)`.
- Write: `placeOrder(input)`, `cancelOrder(input)` — signs via `WalletBackend.signTypedData("polymarket.placeOrder", ...)`.
- Consumed by: `TRADE` (kind=`prediction`), `MANAGE_POSITION`, `QUERY_PORTFOLIO`, `QUERY_MARKET`.

### D.9 `aave`

- Source: `@aave/contract-helpers` or direct contract calls via viem.
- Env: none (uses configured RPC via `wallet`).
- Read: `getMarkets(chainId)`, `getUserPosition(chainId, address)`, `getYields(chainId)`.
- Write: `supply(input)`, `borrow(input)`, `repay(input)`, `withdraw(input)`.
- Consumed by: `LEND`, `QUERY_PORTFOLIO`.

### D.10 `morpho`

- Source: Morpho Blue contracts, viem-based.
- Env: none.
- Read: `getMarkets(chainId)`, `getUserPosition(chainId, address)`, `getYields(chainId)`.
- Write: `supply(input)`, `borrow(input)`, `repay(input)`, `withdraw(input)`.
- Consumed by: `LEND`, `QUERY_PORTFOLIO`.

### D.11 `lp-evm`

- Source: Uniswap V3 SDK (`@uniswap/v3-sdk`), Aerodrome adapter for Base. Single provider, multi-DEX behind a unified surface (mirrors Li.Fi pattern — agent does not name DEXes).
- Env: none.
- Read: `getPool(chainId, address)`, `getUserPositions(chainId, address)`, `quoteRange(input)`.
- Write: `openPosition(input)`, `closePosition(input)`, `collect(input)`, `rebalance(input)`.
- Consumed by: `MANAGE_LP`, `QUERY_PORTFOLIO`.

### D.12 `wallet`

- The runtime's view of `WalletBackend` plus RPC balance fetching. Replaces today's `evmWalletProvider` at `eliza/plugins/plugin-evm/typescript/providers/wallet.ts:576-634`.
- Env: RPC env vars (`ALCHEMY_API_KEY`, etc.) — already documented in `wallet-routes.ts:419-421`.
- Read: `getAddresses()`, `getBalances({ chain })`, `getTokenBalance(chain, token)`.
- Consumed by: every action's validate (capability check), `QUERY_PORTFOLIO` (balances).

### D.13 `automation`

- Backed by an automation runner service that reads/writes the `automations` table.
- Env: none.
- Read: `list(filter)`, `get(automationId)`.
- Write: `create(input)`, `pause(automationId)`, `resume(automationId)`, `delete(automationId)`.
- Consumed by: `SET_AUTOMATION`, `MANAGE_AUTOMATION`. The runner internally invokes `TRADE` when triggers fire.

---

## E. Validation failure codes

Single source of truth at `eliza/packages/agent/src/actions/failure-codes.ts`:

```ts
export type ValidateFailureCode =
  | "INVALID_PARAMS"
  | "PLUGIN_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH_MISSING"
  | "WALLET_NOT_AVAILABLE"
  | "VENUE_NOT_SUPPORTED_ON_BACKEND"
  | "VENUE_NOT_SUPPORTED_FOR_KIND"
  | "POLICY_REQUIRES_APPROVAL"
  | "POLICY_BLOCKED"
  | "INSUFFICIENT_BALANCE"
  | "MARKET_CLOSED"
  | "INSTRUMENT_NOT_FOUND"
  | "LEVERAGE_OUT_OF_RANGE"
  | "SLIPPAGE_EXCEEDED"
  | "WITHDRAWAL_NOT_ALLOWLISTED";

export type ActionFailureCode =
  | "PROVIDER_REJECTED"           // venue API returned an error
  | "SIGNATURE_REJECTED"          // user denied or steward denied
  | "STEWARD_UNAVAILABLE"
  | "ROUTE_NOT_FOUND"             // li.fi could not find a route
  | "TRANSACTION_REVERTED"
  | "TIMEOUT";
```

Every error returned to the planner has a code from these unions. No free-form strings as the primary failure type. The `detail` string is for human reading; the code is for the planner to react on.

---

## F. Audit log + policy enforcement

### F.1 Audit log location and schema

New file: `eliza/packages/agent/src/audit/audit-log.ts`. Backed by an `audit_log` SQL table (use the existing pglite-via-plugin-sql infra — no SQL mocks per the project memory).

```ts
interface AuditLogRow {
  id: bigint;                       // monotonic
  ts: number;                       // epoch ms
  actor: "agent" | "user" | "automation";
  kind: AuditKind;                  // see below
  scope: SignScope | null;
  actionName: string | null;
  paramsHash: string;               // sha256 of JSON.stringify(params)
  approvalId: string | null;
  outcome: "ok" | "validate_fail" | "handler_fail" | "pending_approval" | "approved" | "rejected";
  failureCode: ValidateFailureCode | ActionFailureCode | null;
  detail: string | null;            // bounded length; PII-stripped
  prevHash: string;                 // hash chain
  rowHash: string;                  // sha256 of (this row, sans rowHash, plus prevHash)
}

type AuditKind =
  | "action_validate_start"
  | "action_validate_end"
  | "action_handler_start"
  | "action_handler_end"
  | "wallet_sign_request"
  | "wallet_sign_result"
  | "approval_requested"
  | "approval_resolved"
  | "automation_trigger_fired"
  | "automation_trigger_skipped";
```

Hash chain rule: every row's `rowHash` covers its own fields plus `prevHash` of the previous row. The chain is verified at boot (a tampered row breaks verification and the runtime starts in read-only mode with a loud diagnostic). This makes the audit log evidence-grade.

Privacy filter: pass every `detail` and `paramsHash` source through `eliza/apps/app-training/src/core/privacy-filter.ts` before insert (already required for trajectory writes per CLAUDE.md). PII never enters the audit log.

### F.2 What gets logged

- Every `validate()` start and end — paired by `id` so failed validates show the failing rule.
- Every `handler()` start and end — paired similarly.
- Every `WalletBackend` sign call — request and result, including `pending_approval`.
- Every approval decision (`approved` | `rejected` | `expired`).
- Every automation trigger evaluation (fired or skipped, with reason).

The audit log is **append-only**. There is no update or delete API — period.

### F.3 Policy module

New file: `eliza/packages/agent/src/policy/policy.ts`.

```ts
export interface PolicyEvaluation {
  kind: "ok" | "requires_approval" | "blocked";
  reason?: string;
  rule?: string;             // which rule fired
  cooldownUntil?: number;    // optional ms timestamp
}

export interface PolicyModule {
  evaluate(scope: SignScope, summary: ApprovalSummary): Promise<PolicyEvaluation>;
}
```

Two implementations:

**`steward-policy-bridge.ts`**: delegates to Steward server-side policy. Steward is the source of truth in `WalletBackendKind = "steward"`. The bridge pre-flights via Steward's policy preview endpoint (today implicit in the `pending` response shape at `eliza/apps/app-steward/src/types/steward.ts:111-118`); a pre-flight that says "blocked" returns `kind: "blocked"`, "approved" returns `ok`, otherwise `requires_approval`.

**`local-policy.ts`**: in-process policy module for `WalletBackendKind = "local"`. Mirrors Steward's rule shape so a user can lift the same JSON config from local to cloud without rewriting:

```ts
interface LocalPolicyConfig {
  rules: Array<
    | { kind: "max_size_per_tx"; venue: string; usd: number }
    | { kind: "max_daily_volume"; venue: string; usd: number }
    | { kind: "withdrawal_allowlist"; addresses: ReadonlyArray<Address> }
    | { kind: "cooldown_after_loss"; venue: string; usdLost: number; cooldownMs: number }
    | { kind: "blocked_assets"; tokens: ReadonlyArray<TokenRef> }
  >;
}
```

Stored at `~/.milady/policy.json`; editable from the desktop UI. The local policy never produces `requires_approval` — there is no human approver in local mode; rules are absolute. They can be `ok` or `blocked`. This is the deliberate tradeoff: local mode trades approval-loop UX for offline operation.

The policy module is **the only place** business rules about size/limits/allowlist live. Actions never inline a check like "if size > 10000 and venue is hyperliquid, ask for approval" — that's a policy concern, not an action concern. (AGENTS.md §2: use cases are the only computation layer, but business policy is consolidated; mixing them violates §6 CQRS.)

---

## G. Migration and file deletions

### G.1 plugin-evm

- `eliza/plugins/plugin-evm/typescript/providers/wallet.ts:401-430` — **delete** `generateAndStorePrivateKey`. Replace `initWalletProvider` (lines 432-459) so it pulls a viem `Account` from `WalletBackend.getEvmAccount(chainId)` instead of reading `EVM_PRIVATE_KEY` directly.
- `eliza/plugins/plugin-evm/typescript/providers/wallet.ts:449-454` — **delete** the autogen branch. Missing key throws `WALLET_NOT_AVAILABLE` from validate.
- `eliza/plugins/plugin-evm/typescript/providers/wallet.ts:576-634` — **rewrite** `evmWalletProvider` as a thin reader on top of `WalletBackendService`. It still emits the `address + balances` text block.
- `eliza/plugins/plugin-evm/typescript/providers/wallet.ts:106-330` — keep the `WalletProvider` class as a viem-helper wrapper, but its constructor takes a viem `Account` (not a private key string). The keyed constructor branch (line 234-249) is removed.

### G.2 plugin-solana

- `eliza/plugins/plugin-solana/typescript/keypairUtils.ts:21-35` — **delete** `generateAndStoreKeypair`.
- `eliza/plugins/plugin-solana/typescript/keypairUtils.ts:37-94` — **rewrite** `getWalletKey` to return `{ keypair?, publicKey? }` from `WalletBackend.getSolanaSigner()`. Drop the base64 fallback at lines 55-58 (one canonical encoding: base58).

### G.3 packages/agent/src/api/wallet-routes.ts

- Lines 1150-1183 — **delete** the entire `POST /api/wallet/export` endpoint. Plaintext key export from a server endpoint is a permanent foot-gun. Local users that need their key export it through the desktop app's keychain UI directly (a one-shot dialog that calls `LocalEoaBackend.exportPrivateKey()` after a fresh re-auth). No HTTP surface.
- Lines 478-561 — **rewrite** `POST /api/wallet/import` to delegate to `WalletBackendService.importLocalKey(chain, key)`. Removes direct `EVM_PRIVATE_KEY` assignment to `process.env` (line 519, 740-756).
- Lines 563-797 — **rewrite** `POST /api/wallet/generate`. Local mode → calls `LocalEoaBackend.generate(chain)`; Steward mode → delegates to `StewardBackend.provisionWallet(chain)`. The current "Steward-first" branch (lines 600-730) and the silent fallback to local generation (line 728) — that fallback is **deleted**. If Steward is the active backend and provisioning fails, the endpoint returns 502 with the underlying error.
- The dual-wallet response shape (`buildDualWalletShape`, lines 234-283) **stays for one release** so the existing UI keeps working; mark for deletion in the next major.

### G.4 plugin-evm-bridge in app-steward

- `eliza/apps/app-steward/src/services/steward-evm-bridge.ts:38-74` — **delete** `stewardEvmPreBoot`. The dummy `0x0...001` placeholder (line 27) is unnecessary once `WalletBackend` is the only key reader.
- `eliza/apps/app-steward/src/services/steward-evm-bridge.ts:80-...` — **delete** `stewardEvmPostBoot`. The post-boot account swap is replaced by `StewardBackend` returning a Steward-routed viem `Account` from `getEvmAccount` from the start.
- `eliza/apps/app-steward/src/services/steward-wallet.ts` — **repurpose** as `StewardBackend` impl. Most of the `resolveEffectiveStewardConfig` logic (lines 75-99) carries over; the rest of the file is the new backend.

### G.5 hydrate-wallet-keys-from-platform-store.ts

- `eliza/packages/app-core/src/security/hydrate-wallet-keys-from-platform-store.ts` — **keep**. It already does the right thing: hydrate env from OS keychain. It runs before backend selection, which is correct ordering.
- The list at lines 10-16 stays the same shape but the `STEWARD_*` vars become the input the StewardBackend needs.

### G.6 cloud-wallet.ts

- `eliza/packages/agent/src/cloud/cloud-wallet.ts` — **keep** the client-address-key logic (`getOrCreateClientAddressKey`, lines 89-114) and the `provisionCloudWalletsBestEffort` logic (lines 207-279). These are the bridge to Steward provisioning and stay relevant under `StewardBackend`.
- The `ENABLE_CLOUD_WALLET` flag (lines 38-41) — **deprecate** the gating once Steward is the canonical cloud backend. Replace with `MILADY_WALLET_BACKEND=steward` checks. One release with both paths, then drop the flag.

### G.7 New files added (canonical)

- `eliza/packages/agent/src/wallet/backend.ts` — `WalletBackend` interface
- `eliza/packages/agent/src/wallet/local-eoa-backend.ts`
- `eliza/packages/agent/src/wallet/steward-backend.ts`
- `eliza/packages/agent/src/wallet/select-backend.ts`
- `eliza/packages/agent/src/wallet/pending-approval.ts`
- `eliza/packages/agent/src/policy/policy.ts`
- `eliza/packages/agent/src/policy/local-policy.ts`
- `eliza/packages/agent/src/policy/steward-policy-bridge.ts`
- `eliza/packages/agent/src/providers/provider.ts`
- `eliza/packages/agent/src/providers/registry.ts`
- 13 provider directories under `providers/`
- `eliza/packages/agent/src/actions/define.ts`
- `eliza/packages/agent/src/actions/failure-codes.ts`
- 9 canonical action files under `actions/`
- `eliza/packages/agent/src/audit/audit-log.ts`

---

## H. Surface coverage

### H.1 Desktop (Electrobun)

- Default backend: `LocalEoaBackend`. The Steward sidecar (`steward-sidecar.ts`) does **not** boot in default mode — power-user opt-in only.
- Approval queue badge: stays wired to `ApprovalQueue.tsx` (`eliza/apps/app-steward/src/ApprovalQueue.tsx`), which polls every 10s. Local mode shows zero pending always (no second approver); the badge is hidden when `kind = "local"`.
- The OS-keychain hydration flow (`hydrate-wallet-keys-from-platform-store.ts`) is the canonical key-injection path. Manual key entry on first run goes through a desktop-only IPC handler that writes to keychain, never into the API.

### H.2 Eliza Cloud (web)

- Backend: `StewardBackend`, multi-tenant. Per-user: `STEWARD_TENANT_ID` is the user ID, `STEWARD_AGENT_ID` is `<userId>:<agentId>`.
- New endpoint: `GET /api/wallet/approvals/stream` (SSE). Streams `approval_requested`, `approval_resolved`, `approval_expired`. Auth: cookie session, scoped to the calling tenant.
- New endpoint: `POST /api/wallet/approvals/:id/decision` body `{ decision: "approve" | "reject", reason?: string }`. Calls Steward's existing approve/reject endpoint (already wired in `steward-bridge.ts`).
- Removed endpoint: `POST /api/wallet/export` (G.3).

Per the AGENTS.md §10 rule (every endpoint needs a client trigger), every new endpoint maps to a UI component:

| endpoint | trigger |
|----------|---------|
| `GET /api/wallet/approvals/stream` | Subscribed by the approval-queue badge component on every page that has wallet actions enabled. |
| `POST /api/wallet/approvals/:id/decision` | Approve / reject buttons inside the approval-queue card and inside the inline chat approval card. |

### H.3 Mobile (Capacitor)

- Backend: `StewardBackend`, cloud-routed. The same multi-tenant Steward as Eliza Cloud web.
- Approval observation: the JS bridge subscribes to the SSE stream and forwards events to the Capacitor `LocalNotifications` plugin.
- Approve/reject: the notification action invokes `POST /api/wallet/approvals/:id/decision`. If the app is foreground, taps deep-link to the inline approval card.
- No keystore on device. Keys never leave Steward's vault.

---

## I. Dependency graph

Phases. "Blocking" means downstream phases cannot start until this finishes. "Parallelizable" means it can run alongside its peers.

```
Phase 0 — Foundations (BLOCKING)
  P0.1  Define WalletBackend interface (wallet/backend.ts)            BLOCKING
  P0.2  Define ValidateFailureCode + ActionFailureCode unions         BLOCKING
  P0.3  Define CanonicalProvider + CanonicalAction interfaces         BLOCKING
  P0.4  Define PolicyModule interface                                 BLOCKING
  P0.5  audit-log.ts schema + table migration                         BLOCKING

Phase 1 — Backends (parallel within phase, blocks phase 2+)
  P1.1  LocalEoaBackend impl                                          parallel
  P1.2  StewardBackend impl (lift from steward-wallet.ts)             parallel
  P1.3  select-backend.ts + runtime registration                      blocks on P1.1, P1.2
  P1.4  Migrate plugin-evm/wallet.ts to consume WalletBackend         blocks on P1.3
  P1.5  Migrate plugin-solana/keypairUtils.ts to consume WalletBackend blocks on P1.3
  P1.6  Delete /api/wallet/export endpoint                            parallel with P1.4-5
  P1.7  Delete steward-evm-bridge.ts pre/post boot hooks              blocks on P1.3
  P1.8  Local policy module + steward-policy-bridge                   parallel with P1.1-7

Phase 2 — Provider lifts (parallel)
  P2.1  coingecko provider (lift from otaku)                          parallel
  P2.2  defillama provider (lift from otaku)                          parallel
  P2.3  news provider (CoinDesk + Tavily, lift from otaku)            parallel
  P2.4  sentiment provider                                            parallel
  P2.5  charts provider                                               parallel
  P2.6  lifi provider                                                 parallel
  P2.7  hyperliquid provider                                          parallel
  P2.8  polymarket provider (lift from otaku, add place-orders)       parallel
  P2.9  aave provider                                                 parallel
  P2.10 morpho provider                                               parallel
  P2.11 lp-evm provider                                               parallel
  P2.12 wallet provider rewrite                                       blocks on P1.4
  P2.13 automation provider                                           parallel

Phase 3 — Canonical actions (BLOCKING, can be parallelized internally)
  P3.1  defineCanonicalAction wrapper                                 BLOCKING
  P3.2  TRADE                                                         blocks on P2.6, P2.7, P2.8
  P3.3  MANAGE_POSITION                                               blocks on P2.7, P2.8
  P3.4  QUERY_MARKET                                                  blocks on P2.1-5
  P3.5  QUERY_PORTFOLIO                                               blocks on P2.7-13
  P3.6  LEND                                                          blocks on P2.9, P2.10
  P3.7  MANAGE_LP                                                     blocks on P2.11
  P3.8  TRANSFER                                                      blocks on P2.12
  P3.9  SET_AUTOMATION                                                blocks on P2.13
  P3.10 MANAGE_AUTOMATION                                             blocks on P2.13

Phase 4 — Surface coverage (parallel)
  P4.1  SSE /api/wallet/approvals/stream                              parallel
  P4.2  POST /api/wallet/approvals/:id/decision                       parallel
  P4.3  Desktop tray badge re-wiring for kind=local                   parallel
  P4.4  Capacitor approval JS bridge                                  blocks on P4.1

Phase 5 — Test coverage
  P5.1  ~25 LLM e2e scenarios per the locked decision                 blocks on P3.2-3.10
  P5.2  Audit log hash-chain verification test                        blocks on P0.5
  P5.3  Backend selection matrix test                                 blocks on P1.3
  P5.4  Local policy module rule fixture tests                        blocks on P1.8
```

The coordinator should fan out at Phase 1 and Phase 2 in parallel after Phase 0 lands, then converge at Phase 3.

---

## J. Open questions

Decisions the user must make before coordination starts:

1. **Hyperliquid agent-key delegation.** Hyperliquid lets users delegate a sub-key for trading without giving up custody. Should `LocalEoaBackend` auto-register an agent key on first use, or always sign with the master EOA? Auto-register is safer (compromise of agent key cannot drain funds) but adds a one-time approval flow. Recommendation: yes, auto-register, but the spec leaves it explicit.

2. **Polymarket geographic restrictions.** Polymarket geo-blocks U.S. users. Do we surface a `VENUE_GEO_RESTRICTED` validate failure based on a client-supplied region, or rely on Polymarket's API to reject (yielding `PROVIDER_REJECTED`)? Recommendation: client-supplied region in onboarding, fail at validate. But the user has not specified; the spec defaults to relying on the API's rejection.

3. **`MANAGE_LP` rebalance vs reposition.** Some pool types (concentrated liquidity, like Uniswap v3) allow modifying position range; others (full-range LPs) do not. The `rebalance` kind currently assumes concentrated. Should it be split into `rebalance` (concentrated) and `reposition` (close + open) verbs? Recommendation: keep one verb, dispatch internally based on pool type.

4. **`SET_AUTOMATION` `intent: TradeInputSchema` reuse.** Reusing the trade schema as an embedded "intent" works for DCA and threshold triggers, but `pnl-exit` is structurally different (it's a position rule, not a deferred trade). The current spec models this with three discriminated kinds at the top level — confirm this factoring is correct, or whether `pnl-exit` should be a special case of `MANAGE_POSITION` modify.

5. **Local-mode auto-approve UX.** In local mode the spec says local policy is absolute (no approval loop). But some users would still want a confirmation step before high-value trades. Should we add a `prompt_user_first` policy rule kind that pauses the action and surfaces a confirmation in the chat surface? This blurs the local/steward line; the spec defaults to no, and recommends users opt into Steward if they want approvals.

6. **Audit log retention.** No retention policy is specified. A multi-year append-only log will grow. Default proposal: 90-day rolling local audit, with a "verified hash chain checkpoint" written every 1000 rows so old rows can be archived to cold storage without breaking verification. Needs user sign-off.

7. **Where do the otaku-lifted plugin tests go?** The lifted code from `/tmp/otaku-review-2026-04-29` will have tests that assume the otaku plugin shape. We are reshaping into provider form. Recommendation: drop the original tests, write fresh tests against the provider interface. But the alternative — porting tests — would catch regressions on the lifted business logic. Spec defaults to fresh tests; user may want both for the first cut.

---

End of spec. Implementation agents read top to bottom; the coordinator routes by phase per §I.
