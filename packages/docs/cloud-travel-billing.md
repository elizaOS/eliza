# Cloud-Default Travel + x402 Billing

Status: Active
Last updated: 2026-04-19

## Summary

Travel features (`travel.search_flight`, `travel.search_hotel`,
`travel.book_flight`, `travel.book_hotel`, and `cloud.duffel`) are
**enabled by default** when the user is signed into Eliza Cloud. Each
metered Duffel call is billed against the user's Cloud credit balance
with a **20% Eliza Cloud service fee** applied server-side (matches the
platform-wide `DEFAULT_MARKUP_RATE = 0.2` in
`eliza/cloud/packages/services/billing/src/markup.ts`). When the
balance can't cover a call, the relay returns **HTTP 402** with an
**x402 payment-requirements** envelope so the local agent can route the
user to the existing wallet top-up flow.

## Default policy

`resolveFeatureDefaults({cloudLinked})` lives in
`eliza/plugins/app-lifeops/src/lifeops/feature-flags.types.ts` and is the
only function callers should use to read effective compile-time
defaults. The runtime resolves `cloudLinked` from the
`CLOUD_AUTH` runtime service (`isAuthenticated()`).

| Feature key            | Cloud-linked default | Baseline (no Cloud) |
| ---------------------- | -------------------- | ------------------- |
| `travel.search_flight` | ON                   | ON (read-only)      |
| `travel.search_hotel`  | ON                   | ON (read-only)      |
| `travel.book_flight`   | ON                   | OFF                 |
| `travel.book_hotel`    | ON                   | OFF                 |
| `cloud.duffel`         | ON                   | OFF                 |

`cloud-features-routes` `POST /api/cloud/features/sync` promotes the
Cloud-default-on travel keys into rows with `source = 'cloud'` so the UI
can render the "Enabled via Eliza Cloud · 20% service fee" tag and the
audit trail reflects how the feature was activated.

## 20% service fee

The markup is the platform-wide rate (`DEFAULT_MARKUP_RATE = 0.2` in
`eliza/cloud/packages/services/billing/src/markup.ts`) applied uniformly
across all metered Cloud passthrough services (Twilio SMS, Duffel travel,
etc). The markup is computed Cloud-side. Local code never recomputes it
(commandment 2 / 4): the relay returns a typed `_meta.cost` envelope,
and the lifeops Duffel adapter exposes:

```ts
interface DuffelCallCost {
  totalUsd: number;
  creatorMarkupUsd: number;
  platformFeeUsd: number;
  markupPercent: number | null; // display-only: platformFeeUsd / totalUsd
  metered: boolean;
}
```

`markupPercent` is a display-only ratio derived once at the boundary so
UI components don't repeat the division.

## x402 payment-required protocol

When the user's Cloud credit balance can't cover a metered call, the
Cloud billing layer returns HTTP 402 with payment requirements per the
[x402 spec](https://www.x402.org). Two carrier formats are supported:

1. `WWW-Authenticate: x402 <json>` header (preferred — fewer bytes).
2. JSON body with a top-level `paymentRequirements` array.

Each entry is a `X402PaymentRequirement`:

```ts
interface X402PaymentRequirement {
  amount: string;     // smallest-unit decimal (e.g. "1500000" for 1.50 USDC)
  asset: string;      // "USDC", or an ERC-20 contract address
  network: string;    // "base", "ethereum", "solana", ...
  payTo: string;      // recipient address
  scheme: string;     // currently "exact" only
  expiresAt: string | null;
  description: string | null;
}
```

### End-to-end flow

1. `eliza/plugins/app-lifeops/src/lifeops/travel-adapters/duffel.ts` calls
   the Cloud relay.
2. The relay (`packages/agent/src/api/duffel-relay-routes.ts`) forwards
   the upstream 402 verbatim — preserving status, `Content-Type`, and
   `WWW-Authenticate` — so the local adapter can parse the envelope.
3. `parseX402Response` (in
   `eliza/plugins/app-lifeops/src/lifeops/x402-payment-handler.ts`)
   extracts the requirements; the adapter throws `PaymentRequiredError`.
4. The `BOOK_TRAVEL` action catches `PaymentRequiredError` and enqueues
   an `ApprovalRequest` carrying both the booking intent and the
   payment requirement so the user sees them together. Money movement
   itself happens in the existing wallet UI (commandment 4 — no money
   moves outside the auth + proxy boundary).

## Opting out locally

Power users who don't want the Cloud-managed flow can run the adapter
in **direct mode**:

- Set `ELIZA_DUFFEL_DIRECT=1` and provide your own `DUFFEL_API_KEY`.
- The `cloud.duffel` feature flag should be left at its baseline OFF.
- Direct-mode calls hit `api.duffel.com` directly; no markup is
  applied; `DuffelCallCost.metered` is `false`.

This path is also the recommended fallback for users who choose not to
sign in to Eliza Cloud but still want to enable `travel.book_flight`
locally via Settings → Features.

## Multilingual surface

The `FeatureNotEnabledError` constructor builds a Cloud-aware default
message; consumers that need locale-specific strings should pass
`message` explicitly. The chat-side `BOOK_TRAVEL` confirmation strings
live in the action handler and are subject to the standard i18n
rollout — no new English-only constants are introduced by this change.
