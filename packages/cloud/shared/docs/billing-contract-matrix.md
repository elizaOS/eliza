# Cloud billing contract matrix

**Audit date:** 2026-08-20  
**Audited source:** [`origin/develop@a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7`][source]  
**Scope:** implementation inventory for [#22942][i22942], not a pricing or policy ratification.

This matrix describes the contract observable at the audited commit. A value marked
**UNKNOWN** is deliberately not inferred from UI copy, a dormant schema, or adjacent
work. Every `Uxx` identifier links to its dedicated follow-up issue. “USD balance
unit” below means the numeric unit stored in
`organizations.credit_balance`; the word “credit” is currently not safe as a unit name
because [U01] is unresolved.

## Contract matrix

| Capability | Price | Unit | Entitlement | Limit | Counter | Reset | Enforcement | UI | Ledger | Refund | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Credits | **CONTRADICTION:** the authoritative checkout grants `1.000000` balance unit for $1, while summary/docs/MCP say 100 credits = $1. **UNKNOWN [U01]**. [C01] [C02] [C03] [C04] [C08] | Implementation stores USD balance units; the public “credit” unit is **UNKNOWN [U01]**. [C01] [C05] | Prepaid organization balance; subscription entitlement is not implemented or decided. Human decision: [#20328][i20328]. [C05] | Custom checkout accepts $1–$1,000, but summary advertises a $5 minimum and UI accepts up to $10,000. **UNKNOWN [U11]**. [C02] [C03] [C06] | `organizations.credit_balance` plus `balance_revision`; mutations append `credit_transactions`. [C05] [C09] | None; balance changes by ledger mutation. [C05] | Money paths reserve/debit atomically or fail; checkout converts dollars to exact cents and grants the same numeric amount. [C02] [C07] | Billing tab renders the balance as dollars and offers preset/custom top-up; docs and summary expose the conflicting 100:1 story. [C03] [C04] [C06] | `credit_transactions`; Stripe credit grants are mediated by durable checkout orders. [C09] [T03] | Inference reservation reconciliation returns excess; Stripe refund/chargeback entitlement holds remain **UNKNOWN** pending [#22930][i22930], with UI exposure tracked in **[U15b]**. [I03] | Permanent implementation owner **UNKNOWN [U14]**; matrix inventory is [#22942][i22942]. |
| Inference | Dynamic USD catalog price by provider/model/product/charge type, with platform markup; unavailable pricing fails closed. [I01] [I02] [I03] | Catalog-defined unit (for example input/output tokens or a flat operation) and optional dimensions. [I01] | Authenticated organization with enough prepaid balance; no launched subscription tier is asserted. [I03] [#20328][i20328] | Enforced organization RPM tiers: free 60/100/30/5, paid 120/200/60/10 after $5 paid credit, growth 300/600/120/30 after $100 (completions/embeddings/standard/strict). Weekly credit quotas exist in service code but production enforcement is **UNKNOWN [U12]**. [I04] [I05] | RPM tier derives from paid-credit ledger history; reservations measure actual billable usage. Weekly `current_usage` is not established as a production counter. [I03] [I04] [I05] | RPM window is 60 seconds. Weekly period calculation/reset exists, but wiring is **UNKNOWN [U12]**. [I04] [I05] | Reserve before provider call, reconcile actual usage afterward, and throw when pricing is unavailable. [I02] [I03] | Account Limits shows configured RPM but explicitly does not show live window usage/reset. [I06] | Credit reservation/transaction trail with billed usage metadata. [I03] | Reconciliation refunds unused reservation; provider-failure and chargeback product policy remains **UNKNOWN** pending [#22930][i22930], with UI exposure tracked in **[U15b]**. [I03] | Permanent implementation owner **UNKNOWN [U14]**. |
| Storage | Migration seeds PUT $0.0001/request + $0.000000001/byte; GET/HEAD/list/presign $0.00005; DELETE $0. Public docs instead say 0.01 credits/GB/day, and missing all DB rows falls back to $0.001/request. **UNKNOWN [U06]**. [S01] [S02] [S03] | Implementation bills request and byte units; docs describe GB/day. **UNKNOWN [U06]**. [S01] [S03] | Authenticated organization; default quota row is 5 GiB. [S01] [S04] | Default hard 5 GiB quota (413 on excess). Generated-media behavior when storage rejects is a human decision in [#20956][i20956]. Production reads/list/presign remain gated by [#21045][i21045] and [#22399][i22399]. [S01] [S04] | `org_storage_quota.bytes_used`/`bytes_limit`; paid operations use durable operation identity. [S04] [S05] | No periodic reset; delete decrements accounted bytes. [S01] [S04] | Atomic quota reservation on PUT and durable billing around object operations; do not infer production activation past the protected canary gates. [S04] [S05] [#21045][i21045] [#22399][i22399] | Account Limits exposes quota-accounted upload bytes, not every stored object; public billing docs carry the conflicting GB/day price. [S03] [S06] | Credit transactions plus storage-operation billing/idempotency records. [S05] | Failure/refund timing for generated media versus storage rejection is **UNKNOWN** pending human decision [#20956][i20956]; broader payment reversal holds are **UNKNOWN [U15b]** / [#22930][i22930]. | Active production gates: [#21045][i21045], [#22399][i22399]. Permanent owner and canonical price owner **UNKNOWN [U14]**. |
| Shared agents | No dedicated-hosting charge: shared is container-free and excluded from the agent hosting biller; inference is billed separately at inference prices. [A01] [A02] | Hosted inference usage; no elapsed container-hour unit. [A01] [A02] | Default derived tier for agents that do not require a custom image, persistent connection/state, or always-on runtime. [A01] | All non-terminal agent sandboxes share a balance-derived ceiling: 5 below $1, 20 at $1, 100 at $10, 500 at $100. [A03] | Non-terminal sandbox count plus ordinary inference reservations/usage. [A03] [I03] | No periodic quota reset; count falls when lifecycle reaches a non-counted state. [A03] | Creation remains bounded by the sandbox quota; shared creation skips dedicated credit/provisioning gates and the hosting biller excludes `execution_tier='shared'`. [A02] [A04] | Onboarding says shared chat is free/no card; Account Limits combines shared and dedicated sandbox counts, so this is not a standalone inference-price display. [A05] [A06] | No `agent_billing_records` for shared hosting; inference uses the credit ledger. [A02] [I03] | Inference reservation reconciliation applies; payment reversal policy remains **UNKNOWN** pending [#22930][i22930], with UI exposure tracked in **[U15b]**. [I03] | Permanent implementation owner **UNKNOWN [U14]**. |
| Dedicated agents | Current constants: running $0.01/hour; stopped with snapshot $0.0025/hour. Creation/resume requires more than $0.10; shared→dedicated upgrade requires $0.72 runway. Sleeping/frozen retention economics and conflicting `$0/hour` UI are **UNKNOWN [U13]**. [D01] [D02] | Prorated elapsed hour by recorded compute-rate segments; snapshot-retention unit is **UNKNOWN [U13]**. [D01] [D03] | Tier is derived when configuration requires dedicated runtime; credit/runway gates apply. [A01] [D01] | Same 5/20/100/500 non-terminal sandbox ceiling as shared agents. [A03] | Billable selector plus `last_billed_at`, state/rate segments, and total billed. [D03] | No clock reset; `last_billed_at` advances after settlement. [D03] | Hourly transaction locks the sandbox/org, rejects shared/deletion-in-flight rows, debits atomically, and records the billing period. The deletion guard is already in the audited baseline; [#22553][i22553] owns remaining live/prod biller proof, not that merged predicate. [D03] | Pricing surfaces show running rates; one badge says sleeping is $0, which must not be treated as retention policy. **UNKNOWN [U13]**. [D02] | `agent_billing_records` linked to `credit_transactions`, with rate segments. [D03] | Frozen/sleeping retention, resource holds, and payment reversal behavior are **UNKNOWN [U13]** / **[U15b]**, adjacent to [#20726][i20726] and pending [#22930][i22930]. | Active bounded live/prod slice: [#22553][i22553]. Permanent owner **UNKNOWN [U14]**. |
| Containers | Implemented running-price constants include $0.67/base-instance day (~$20/month), resource-scaled with 20% markup. The catalogue also advertises deployment, image, storage, bandwidth, and extra-instance charges without an audited billing caller: **UNKNOWN [U07]**. [N01] [N02] | Prorated running day, scaled by desired count/CPU/memory. Units for the additional advertised charges are **UNKNOWN [U07]** until each is either metered or removed. [N01] [N02] | Organization credits; optional pay-from-earnings setting. **CONTRADICTION:** policy and UI promise earnings-first, but transaction code applies credits first. **UNKNOWN [U02]**. [N03] [N04] [N05] | Balance-derived ceiling 1/5/25/100 (free/starter/professional/enterprise), with optional organization override. [N01] [N06] | Active container count, `last_billed_at`, credit balance, and redeemable earnings balance. [N02] [N06] | No periodic quota reset; billing advances elapsed-time cursor. [N02] [N06] | Create locks the organization, counts and inserts atomically, then deployment debit occurs in the same transaction; cron settles prorated hosting. Settlement ordering currently contradicts policy/UI. [N02] [N04] [N06] | Pay-as-you-go card explicitly promises earnings before credits. [N05] | `container_billing_records`, `credit_transactions`, and `redeemable_earnings_ledger`. [N04] | Failed atomic settlement does not partially debit; reversal/resource-hold policy is **UNKNOWN** pending [#22930][i22930], with UI exposure tracked in **[U15b]**. [N04] | Permanent implementation owner **UNKNOWN [U14]**. |
| API keys | **UNKNOWN [U08]**: no per-key price is enforced or documented in the audited create/auth path. Related lifecycle work [#22551][i22551] and [#22920][i22920] does not decide price. [K01] [K02] | **UNKNOWN [U08]**: stored `rate_limit` has no authoritative time unit in runtime enforcement. [K01] [K02] | Authenticated organization user may create a key; provisioner-reserved names are rejected. [K02] | Caller may store 1–100,000 (default 1,000), but runtime enforcement and organization key-count cap are **UNKNOWN [U08]**. [K01] [K02] | `usage_count` is telemetry, debounced once/minute/process; it is not an exact quota counter. [K03] | No authoritative rate window or usage reset. **UNKNOWN [U08]**. [K01] [K03] | Create route has auth/validation but no price or count gate; no audited runtime consumer establishes enforcement of the stored rate. **UNKNOWN [U08]**. [K02] | API Keys surface lists/creates/revokes keys and displays stored usage/rate fields. [K04] | No dedicated billing ledger; downstream billable calls use their own ledger. [K02] | No key-creation charge to refund is established; downstream refund rules apply. **UNKNOWN [U08]**. | Permanent implementation owner **UNKNOWN [U14]**. |
| One-off top-ups | Custom Stripe checkout charges exact dollars and grants the same numeric balance amount. API allows $1–$1,000; UI allows $1–$10,000; summary says $5 minimum. Stored credit-pack economics have no authoritative seed contract. **UNKNOWN [U11]**. [C02] [C03] [C06] [T01] | USD card charge in cents → USD balance unit; public “credits” naming remains **UNKNOWN [U01]**. [C02] | Successful provider payment/order settlement; fixed x402 endpoints also expose $10/$50/$100 top-ups. [T02] [T03] | Conflicting custom min/max noted under Price; pack set and minimum are **UNKNOWN [U11]**. [C02] [C03] [C06] [T01] | Durable checkout order, provider session/payment identity, and balance revision. [T03] | None; each order is independently idempotent. [T03] | Checkout order pins charge/grant and settles exactly once before credit ledger mutation. [T03] | Billing tab presets/custom form; current client max conflicts with API max. [C06] | `stripe_checkout_orders` linked to `credit_transactions`. [T03] | Stripe refund/chargeback entitlement clawback/holds need human decision [#22930][i22930]; direct-crypto refund/overpayment policy is **UNKNOWN [U16]**. | Permanent implementation owner **UNKNOWN [U14]**. |
| Auto top-up | Configured credited amount $1–$1,000. With affiliate attribution, card charge adds affiliate markup and a 20% platform fee while the configured amount is credited; pricing presentation remains part of **UNKNOWN [U11]**. [AT01] [AT06] | USD card charge in cents → USD balance unit. [AT01] | Organization opt-in, threshold/amount, usable saved payment method, durable database control plane, and runtime flag exactly `true`. Production activation is human/operator-gated. [AT01] [AT02] | Threshold $0–$1,000; amount $1–$1,000; one blocking attempt per organization with leases/retries. [AT01] [AT03] | Durable `auto_top_up_attempts` state machine, lease, provider/payment identity, and linked credit transaction. [AT03] | No clock reset; after a success, re-arm requires a later balance decrease below threshold. [AT02] | Code path exists but remains disabled unless the env flag and durable-store cutover are approved; config intentionally omits the flag. Do not claim production activation. [AT01] [AT02] [AT04] | Billing card edits enablement, threshold, amount, and payment method. [AT05] | `auto_top_up_attempts` linked to `credit_transactions` and provider payment intent. [AT03] | Refund/chargeback entitlement behavior remains human-gated in [#22930][i22930]. | Active durable/cutover slice [#20717][i20717] plus named human operator approval; permanent owner **UNKNOWN [U14]**. |
| Earnings/redemptions | Earned balance is USD-denominated; redemption uses 100 points = $1 and applies a 2% quote safety spread (fees configured to zero). [E01] [E02] [E03] | Implementation uses a redeemable USD balance and integer points (one point = $0.01); the canonical external earnings unit is **UNKNOWN [U09]**. [E01] [E02] [E06] | Authenticated owner with available earnings, valid payout address, liquid payout inventory, and admin approval. [E02] [E03] | Request 100–100,000 points ($1–$1,000); user $1,000/hour and $5,000/day; system $10,000/hour and $50,000/day; max 10 requests/5 min; all requests require admin approval. [E02] [E03] | Available/pending/lifetime earnings, immutable earnings ledger, token-redemption state, rate/velocity counters. [E01] [E03] | Hour/day windows, 5-minute request window, 5-minute user cooldown, and max 24-hour pending review. [E03] | Critical route limiter plus secure redemption service, velocity/liquidity checks, idempotency, and admin approval. **CONTRADICTION:** UI sends/query `amount`, while quote and POST APIs require `pointsAmount`; UI also expects stale quote field names. **UNKNOWN [U03]**. [E02] [E04] [E05] | Earnings page currently uses the incompatible `amount` contract, so quote/submit flow is not authoritative until **U03** is fixed. [E05] | `redeemable_earnings`, immutable `redeemable_earnings_ledger`, and `token_redemptions`. [E01] [E02] | Failed/cancelled redemption can restore earnings via ledger refund; external payment/chargeback policy remains **UNKNOWN** pending [#22930][i22930], with UI exposure tracked in **[U15b]**. [E01] | Permanent implementation owner **UNKNOWN [U14]**; API/UI repair needs a dedicated issue **[U03]**. |

## UNKNOWN register

An adjacent issue is listed only as context; it does **not** close the UNKNOWN unless
the dedicated issue explicitly owns the decision and lands an authoritative contract.

| ID | Unresolved contract | Evidence / contradiction | Tracking and gate |
| --- | --- | --- | --- |
| [U01] | `credit-unit-usd-vs-100`: choose one externally visible credit unit and migrate every API, UI, doc, MCP price, and ledger label consistently. | Checkout/balance are 1 unit = $1; summary/docs/MCP say 100 units = $1. [C01] [C02] [C03] [C04] [C08] | Dedicated issue [#22952][U01]. Human launch-model decision [#20328][i20328] is adjacent, not a unit decision. |
| [U02] | `container-earnings-first-order`: make policy, UI, plan, and transactional settlement use the same funding order. | Policy/UI earnings-first; repository credits-first. [N03] [N04] [N05] | Dedicated issue [#22951][U02]. |
| [U03] | `earnings-redemption-contract`: standardize query/body and response field names, then add UI↔route contract tests. | UI uses `amount`, `elizaPriceUsd`, `expiresAt`, and `safetySpread`; APIs require `pointsAmount` and return `twapPriceUsd`, `validUntil`, and `safetySpreadPercent`. [E02] [E04] [E05] | Dedicated issue [#22953][U03]. |
| [U04] | `canonical-billing-snapshot`: define one read model for balances, active billables, limits, payment state, and reset windows. | Current UI snapshots are capability-specific and explicitly omit some live usage/reset data. [I06] [S06] [A06] | Dedicated issue [#22954][U04]. |
| [U05] | `billing-mutation-roles`: define which human/service/API-key roles may mutate balance, pricing, quota, refund, and payout state. | Authority is distributed across route-local auth and service code; no canonical role matrix was found. | Dedicated issue [#22959][U05]. |
| [U06] | `storage-price-docs-fallback`: ratify storage units/prices and decide fail-closed versus undercharging fallback. | Seed contains a pricing TODO; runtime undercharges on a missing table; public docs use a third unit/rate. [S01] [S02] [S03] | Dedicated issue [#22956][U06]. [#21045][i21045] and [#22399][i22399] own production storage paths, not product pricing. |
| [U07] | `ghost-container-charges`: make every advertised deployment, image, storage, bandwidth, reference-instance, and extra-instance price either idempotently metered with a receipt or remove it from the product contract. | Constants advertise several charges, while the audited billing callers establish only running CPU/memory/count proration. [N01] [N02] | Dedicated issue [#22957][U07]. [#22553][i22553] remains the adjacent billing-selection goal and is not duplicated. |
| [U08] | `api-key-price-count-per-key-rate`: decide key price, org count ceiling, rate unit/window, exact counter, reset, and enforcement point. | Create stores caller-selected 1–100,000; usage counter is approximate telemetry; no creation price/count gate or runtime rate consumer is established. [K01] [K02] [K03] | Dedicated issue [#22958][U08]. [#22551][i22551] and [#22920][i22920] are lifecycle/revocation only. |
| [U09] | `earnings-usd-vs-points`: choose the canonical earnings/redemption unit and conversion/display rules. | Earnings ledger is USD-denominated while redemption HTTP uses integer points at one cent each. [E01] [E02] | Dedicated issue [#22960][U09]. |
| [U10] | `mcp-dual-settlement`: define the funding invariant for buyer debit/credit, platform fee, and creator redeemable earnings so one MCP purchase cannot mint duplicate value. | The MCP settlement path can affect both organization credits and creator earnings; the audit found no durable product decision proving whether this is an intentional two-sided transfer or duplicate value. [C08] | Dedicated issue [#22961][U10]. |
| [U11] | `credit-pack-seeds-min-topup`: choose the authoritative pack set, one-off min/max, and presentation of auto-top-up affiliate surcharge. | Checkout, summary, and UI disagree; schema is data-driven without a canonical seed in this audit. [C02] [C03] [C06] [T01] [AT01] | Dedicated issue [#22963][U11]. [#20717][i20717] owns durable auto top-up, not pack pricing. |
| [U12] | `weekly-inference-enforcement`: decide whether weekly quotas launch and wire atomic check/track/reset if they do. | Weekly service methods exist, but the audited inference billing flow only establishes RPM and credit reservation enforcement. [I03] [I04] [I05] | Dedicated issue [#22962][U12]. [#20328][i20328] is a human subscription-model decision, not quota wiring. |
| [U13] | `sandbox-frozen-retention-economics`: define sleeping/frozen snapshot retention, restoration, deletion, and billing states. | Billing constants charge stopped snapshots; UI says sleeping is $0; selector only bills stopped rows with backups. [D01] [D02] [D03] | Dedicated issue [#22967][U13]. [#20726][i20726] is adjacent retention/GC work; [#22553][i22553] owns current biller hardening, not policy. |
| [U14] | `billing-implementation-ownership`: name durable code owners and escalation paths per capability. | [#22942][i22942] is docs-only; active issue assignees are not permanent subsystem ownership. | Dedicated issue [#22964][U14]. |
| [U15a] | `active-billables-ui`: expose a canonical, auditable list of currently billable resources and their rates/states. | Current UI is split across capability cards and does not provide one authoritative active-billables view. [I06] [S06] [A06] | Dedicated issue [#22965][U15a]. |
| [U15b] | `refunds-payment-states-ui`: implement the ratified entitlement/resource holds, ledger reversals, receipts, and visible payment states. | Subsystems have local rollback/reconciliation, but there is no ratified cross-surface reversal contract. | Dedicated issue [#22966][U15b], blocked on human decision [#22930][i22930]. |
| [U16] | `direct-crypto-refund-overpayment`: define overpayment, duplicate, refund, and entitlement handling for direct/x402 crypto top-ups. | Exact-once crediting does not itself define provider/direct-crypto refund policy. [T02] [T03] | Dedicated issue [#22968][U16]. [#22327][i22327] and [#22850][i22850] are adjacent but do not own provider/direct-crypto reversal policy. |

## Human and production gates preserved by this inventory

- [#20328][i20328] is an open human decision. This document does not claim that
  prepaid/PAYG-only or a subscription model has been ratified.
- [#20956][i20956] is an open human decision for generated-media charging when
  storage quota enforcement rejects or later removes an object.
- [#22930][i22930] is an open human decision for Stripe refunds, disputes,
  chargebacks, entitlement clawback, resource holds, and customer-visible state.
- [#21045][i21045] and [#22399][i22399] remain protected production/canary gates for
  the storage data plane. Source presence is not production activation.
- [#20717][i20717] has durable implementation in the audited tree, but the runbook
  still requires an authorized operator, provider fencing/canary evidence, database
  activation, and then the runtime flag. The audited Wrangler config intentionally
  omits that flag. [AT02] [AT04]
- [#22553][i22553] is the active claimed agent-biller/storage-payload goal. The
  deletion-in-flight exclusion and atomic debit shown in [D03] are already present at
  the audited commit; this matrix does not re-claim them.
- [#22942][i22942] owns only this documentation/inventory. It does not resolve any
  policy UNKNOWN by itself.

## Evidence anchors

All code links below are pinned to the audited commit.

- **Credits:** [C01] balance unit; [C02] checkout input/exact charge/grant; [C03]
  summary conversion/minimum; [C04] docs 100:1 claim; [C08] MCP 100:1 settlement;
  [C05] balance schema; [C09] transaction ledger schema; [C06] billing UI
  input/display; [C07] atomic credit service.
- **Inference:** [I01] price catalog; [I02] fail-closed lookup; [I03]
  reservation/reconciliation; [I04] spend-derived RPM tiers/window; [I05] weekly quota
  service; [I06] UI snapshot limitation.
- **Storage:** [S01] quota/pricing migration; [S02] missing-price fallback; [S03]
  public docs; [S04] atomic quota repository; [S05] billed PUT route; [S06] UI scope.
- **Agents:** [A01] tier derivation; [A02] hosting selector; [A03] shared ceiling;
  [A04] create path; [A05] onboarding copy; [A06] account snapshot. Dedicated: [D01]
  prices/gates; [D02] UI; [D03] atomic biller and ledger.
- **Containers:** [N01] prices/limits; [N02] cron proration; [N03] funding policy;
  [N04] transactional settlement; [N05] UI promise; [N06] atomic quota/create/debit.
- **API keys:** [K01] schema; [K02] create route/schema; [K03] approximate usage
  counter; [K04] UI.
- **Top-ups:** [T01] data-driven packs; [T02] fixed direct top-up; [T03] exact-once
  Stripe order settlement. Auto top-up: [AT01] bounds; [AT06] fee calculation; [AT02]
  cutover runbook; [AT03] attempt ledger; [AT04] omitted runtime flag; [AT05] UI.
- **Earnings:** [E01] earnings balance/ledger; [E02] redemption API/schema; [E03]
  security limits; [E04] quote contract; [E05] incompatible UI request/response;
  [E06] points-to-USD storage contract.

[source]: https://github.com/elizaOS/eliza/tree/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7
[C01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/credits.ts#L670-L676
[C02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/credits/checkout/route.ts#L35-L151
[C03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/credits/summary/route.ts#L171-L175
[C04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/docs/tracks/cloud/billing.mdx#L6-L8
[C05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/organizations.ts#L43-L59
[C06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/billing/components/billing-tab.tsx#L61-L492
[C07]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/credits.ts#L286-L390
[C08]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/user-mcps.ts#L521-L597
[C09]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/credit-transactions.ts#L17-L62
[I01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/ai-pricing.ts#L18-L50
[I02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/ai-pricing/lookup.ts#L44-L165
[I03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/ai-billing.ts#L316-L505
[I04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/org-rate-limits.ts#L42-L304
[I05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/usage-quotas.ts#L48-L269
[I06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/billing/components/account-limits-card.tsx#L492-L510
[S01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/migrations/0102_add_org_storage_quota.sql#L1-L38
[S02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/proxy/pricing.ts#L7-L89
[S03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/docs/cloud/billing.mdx#L53-L60
[S04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/repositories/org-storage-quota.ts#L12-L71
[S05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/apis/storage/objects/%5B...key%5D/route.ts#L96-L169
[S06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/billing/components/account-limits-card.tsx#L393-L441
[A01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/shared-runtime/agent-tier.ts#L1-L74
[A02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/repositories/agent-billing.ts#L105-L148
[A03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/constants/agent-sandbox-quota.ts#L26-L54
[A04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/eliza/agents/route.ts#L344-L422
[A05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/eliza-app/onboarding-chat.ts#L169-L175
[A06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/account-limits-snapshot.ts#L231-L297
[D01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/constants/agent-pricing.ts#L1-L48
[D02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/instances/components/agent-cost-badge.tsx#L1-L65
[D03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/repositories/agent-billing.ts#L296-L439
[N01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/constants/pricing.ts#L31-L219
[N02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/cron/container-billing/route.ts#L80-L108
[N03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/container-billing-policy.ts#L41-L81
[N04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/repositories/container-billing.ts#L300-L462
[N05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/billing/components/pay-as-you-go-card.tsx#L105-L137
[N06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/repositories/containers.ts#L724-L875
[K01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/api-keys.ts#L16-L62
[K02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/api-keys/route.ts#L61-L144
[K03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/api-keys.ts#L62-L69
[K04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/api-keys/ApiKeysSurface.tsx#L44-L95
[T01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/credit-packs.ts#L14-L41
[T02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/topup/10/route.ts#L20-L36
[T03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/stripe-checkout-orders.ts#L454-L520
[AT01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/auto-top-up.ts#L36-L53
[AT02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/docs/auto-top-up-durable-cutover.md#L12-L26
[AT03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/auto-top-up-attempts.ts#L53-L162
[AT04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/wrangler.toml#L199-L205
[AT05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/billing/components/auto-top-up-card.tsx#L408-L510
[AT06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/services/auto-top-up.ts#L1049-L1111
[E01]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/redeemable-earnings.ts#L68-L178
[E02]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/redemptions/route.ts#L27-L41
[E03]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/lib/config/redemption-security.ts#L45-L149
[E04]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/api/v1/redemptions/quote/route.ts#L34-L227
[E05]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/ui/src/cloud/monetization/earnings/EarningsPageClient.tsx#L97-L286
[E06]: https://github.com/elizaOS/eliza/blob/a83adaa8eba1901b1e9fa99e177b4e0f1d7e8bc7/packages/cloud/shared/src/db/schemas/token-redemptions.ts#L64-L104

[i20328]: https://github.com/elizaOS/eliza/issues/20328
[i20717]: https://github.com/elizaOS/eliza/issues/20717
[i20726]: https://github.com/elizaOS/eliza/issues/20726
[i20956]: https://github.com/elizaOS/eliza/issues/20956
[i21045]: https://github.com/elizaOS/eliza/issues/21045
[i22327]: https://github.com/elizaOS/eliza/issues/22327
[i22399]: https://github.com/elizaOS/eliza/issues/22399
[i22551]: https://github.com/elizaOS/eliza/issues/22551
[i22553]: https://github.com/elizaOS/eliza/issues/22553
[i22850]: https://github.com/elizaOS/eliza/issues/22850
[i22920]: https://github.com/elizaOS/eliza/issues/22920
[i22930]: https://github.com/elizaOS/eliza/issues/22930
[i22942]: https://github.com/elizaOS/eliza/issues/22942

[U01]: https://github.com/elizaOS/eliza/issues/22952
[U02]: https://github.com/elizaOS/eliza/issues/22951
[U03]: https://github.com/elizaOS/eliza/issues/22953
[U04]: https://github.com/elizaOS/eliza/issues/22954
[U05]: https://github.com/elizaOS/eliza/issues/22959
[U06]: https://github.com/elizaOS/eliza/issues/22956
[U07]: https://github.com/elizaOS/eliza/issues/22957
[U08]: https://github.com/elizaOS/eliza/issues/22958
[U09]: https://github.com/elizaOS/eliza/issues/22960
[U10]: https://github.com/elizaOS/eliza/issues/22961
[U11]: https://github.com/elizaOS/eliza/issues/22963
[U12]: https://github.com/elizaOS/eliza/issues/22962
[U13]: https://github.com/elizaOS/eliza/issues/22967
[U14]: https://github.com/elizaOS/eliza/issues/22964
[U15a]: https://github.com/elizaOS/eliza/issues/22965
[U15b]: https://github.com/elizaOS/eliza/issues/22966
[U16]: https://github.com/elizaOS/eliza/issues/22968
