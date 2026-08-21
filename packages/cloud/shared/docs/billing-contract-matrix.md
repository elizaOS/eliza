# Cloud billing contract matrix

**Audit date:** 2026-08-21<br>
**Audited source:** [`origin/develop@9edb8e24017b4675669e79ea6560b38a19aa8ec5`][source]<br>
**Scope:** implementation inventory for [#22942][i22942], not a pricing or policy ratification.

This matrix describes the contract observable at the audited commit. A value marked
**UNKNOWN** is deliberately not inferred from UI copy, a dormant schema, or adjacent
work. Every `Uxx` identifier links to its dedicated follow-up issue. “USD balance
unit” below means the numeric unit stored in
`organizations.credit_balance`: one organization cloud credit equals $1 USD.
Legacy user-MCP `credits_per_request` values remain cent-like pricing points at
100 points per dollar and are converted at the service/API boundary; they are
not organization cloud-credit balances.

## Contract matrix

| Capability | Price | Unit | Entitlement | Limit | Counter | Reset | Enforcement | UI | Ledger | Refund | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Credits | One organization cloud credit equals $1 USD. Checkout charges dollars and grants the same numeric balance amount; summary, docs, UI, and new MCP price fields use that denomination. Legacy MCP pricing points are converted at 100 points per dollar without rescaling organization balances. [C01] [C02] [C03] [C04] [C08] | USD-denominated organization cloud credit (1 credit = $1). [C01] [C05] | Decision B ratifies $30 Plus and $100 Pro subscriptions with separate expiring allowances, but no subscription entitlement is active in the audited source. The catalog foundation is still draft in [#23154][p23154]; current usage continues against purchased organization credits. [#20328][i20328] [C05] | Custom checkout accepts $1–$1,000, but summary advertises a $5 minimum and UI accepts up to $10,000. **UNKNOWN [U11]**. [C02] [C03] [C06] | `organizations.credit_balance` plus `balance_revision`; mutations append `credit_transactions`. Legacy MCP point columns remain storage-compatible and are converted at the service boundary. Future subscription allowance must remain a separate expiring authority. [C05] [C08] [C09] [#20328][i20328] | None for purchased credits; the ratified subscription allowance will expire at billing-period end after its implementation program lands. [C05] [#20328][i20328] | Money paths reserve/debit atomically or fail; checkout converts dollars to exact cents and grants the same numeric amount. The MCP adapter is value-preserving and idempotent, so no customer-balance migration or backfill is required. The subscription program is not yet enforcement authority. [C02] [C07] [C08] | Billing tab renders the balance as dollars; MCP pricing is entered and displayed in USD cloud credits. Subscription selection/management remains future work, not a launched surface. [C03] [C04] [C06] [C08] | `credit_transactions`; Stripe credit grants are mediated by durable checkout orders. No subscription allowance ledger is active in the audited source. [C09] [T03] | Worker deferred settlement records actual usage; compatibility reservation reconciliation returns excess. Stripe reversal entitlement remains **UNKNOWN** pending [#22930][i22930]; server hold/reversal work is **[U19]** and customer-visible states/receipts are **[U15b]**. [I03] [I08] [I09] | Permanent implementation owner **UNKNOWN [U14]**; subscription program [#23090][i23090]–[#23097][i23097]; matrix inventory [#22942][i22942]. |
| Inference | Dynamic USD catalog price by provider/model/product/charge type, with platform markup. On a missing exact token price, runtime uses the highest matching provider/product/charge catalog rate, then configured environment fallback; it fails closed only if neither exists. Flat-operation pricing remains exact-catalog or fail-closed. [I01] [I02] [I07] | Catalog-defined unit (for example input/output tokens or a flat operation) and optional dimensions. [I01] | Authenticated organization with enough purchased balance in the audited implementation. Decision B defines future Plus/Pro allowance-first funding, but that subscription entitlement path has not landed. [I03] [#20328][i20328] [#23092][i23092] | Current runtime applies spend-derived RPM tiers of 60/100/30/5, 120/200/60/10 at the $5 threshold, and 300/600/120/30 at $100 (completions/embeddings/standard/strict). Decision B assigns the latter two envelopes to Plus/Pro once entitlement-derived enforcement lands; current cumulative-credit qualification is not proof of an active subscription. Weekly credit quotas exist in service code but production enforcement is **UNKNOWN [U12]**. [I04] [I05] [I10] [I11] [I12] [I13] [#23094][i23094] | Production Worker admission tracks a serialized Durable Object balance lease before dispatch and deterministic post-usage debit; compatibility paths may use synchronous credit reservation/reconciliation or DB/KV admission ledgers. No active subscription-allowance counter is present in the audited source. [I03] [I04] [I05] [I08] [I09] [I11] [I12] [I13] | RPM window is 60 seconds. Weekly period calculation/reset exists, but wiring is **UNKNOWN [U12]**. Future monthly allowances expire at billing-period end after implementation. [I04] [I05] [#20328][i20328] | Production Worker config enables deferred admission against purchased credits. The ratified subscription path will consume allowance first only after [#23092][i23092] and entitlement enforcement [#23094][i23094] land; do not infer activation from the decision or draft catalog. Token pricing follows the existing fallback ladder. [I02] [I03] [I07] [I08] [I09] [I10] [I11] [I12] [I13] | Account Limits shows configured RPM but explicitly does not show live window usage/reset; subscription selection/management is not yet active. [I06] [#23096][i23096] | Durable Object lease plus post-usage credit transaction on the current path. Future allowance accounting must use its separate expiring ledger, not `addCredits`. [I03] [I08] [I09] [I11] [I12] [I13] [#20328][i20328] | Reconciliation refunds unused synchronous reservation; deferred settlement records actual collected/uncollected outcome. Stripe reversal policy remains **UNKNOWN** pending [#22930][i22930]; server implementation is **[U19]** and UI/receipt exposure is **[U15b]**. [I03] [I08] | Permanent implementation owner **UNKNOWN [U14]**; subscription enforcement is tracked by [#23092][i23092] and [#23094][i23094]. |
| Storage | Migration seeds PUT $0.0001/request + $0.000000001/byte; GET/HEAD/list/presign $0.00005; DELETE $0. Public docs instead say 0.01 credits/GB/day. When pricing rows are missing, runtime falls back to $0.001 per lookup component; PUT therefore becomes $0.001 + $0.001 per byte, while every single-component lookup—including DELETE—becomes $0.001. **UNKNOWN [U06]**. [S01] [S02] [S03] [S05] [S07] | Implementation bills request and byte units; docs describe GB/day. **UNKNOWN [U06]**. [S01] [S03] | Authenticated organization; default quota row is 5 GiB. [S01] [S04] | Default hard 5 GiB quota (413 on excess). Generated-media behavior when storage rejects is a human decision in [#20956][i20956]. Production reads/list/presign remain gated by [#21045][i21045] and [#22399][i22399]. [S01] [S04] | `org_storage_quota.bytes_used`/`bytes_limit`; paid operations use durable operation identity. [S04] [S05] | No periodic reset; delete decrements accounted bytes. [S01] [S04] | Atomic quota reservation on PUT and durable billing around object operations; do not infer production activation past the protected canary gates. [S04] [S05] [#21045][i21045] [#22399][i22399] | Account Limits exposes quota-accounted upload bytes, not every stored object; public billing docs carry the conflicting GB/day price. [S03] [S06] | Credit transactions plus storage-operation billing/idempotency records. [S05] | Failure/refund timing for generated media versus storage rejection is **UNKNOWN** pending human decision [#20956][i20956]. Stripe reversal/resource-hold policy is pending [#22930][i22930], with server authority **[U19]** and UI/receipt exposure **[U15b]**. | Active production gates: [#21045][i21045], [#22399][i22399]. Permanent owner and canonical price owner **UNKNOWN [U14]**. |
| Shared agents | No dedicated-hosting charge: shared is container-free and excluded from the agent hosting biller. Standard shared REST inference defaults to organization-credit funding; the canonical Personal Shared path selects platform funding and does not debit organization credits. [A01] [A02] [A07] [A08] [A09] | No elapsed container-hour unit. Standard shared inference uses catalog-priced usage; Personal Shared has no organization-credit unit. [A01] [A02] [A07] [A08] [A09] | Default derived tier for agents that do not require a custom image, persistent connection/state, or always-on runtime; inference funding remains surface-specific as described under Price. [A01] [A07] [A08] [A09] | The audited non-eager/shared creation path uses a fixed ceiling of 5 against the combined non-terminal, non-pool sandbox population (shared plus dedicated). [A03] [A04] [A06] | Combined non-terminal sandbox count plus standard shared inference admission/usage; Personal Shared usage is platform-funded. [A03] [A06] [A07] [A08] [A09] [I03] [I08] [I09] | No periodic quota reset; count falls when lifecycle reaches a non-counted state. [A03] | The audited standard creation path is bounded by the fixed non-eager sandbox quota; shared creation skips dedicated credit/provisioning gates and the hosting biller excludes `execution_tier='shared'`. A later path audit found managed-Discord and eliza-app provisioning front doors that do not yet share the same atomic quota authority; [#23003][i23003] owns that bounded repair. Standard shared inference and Personal Shared use the distinct funding authorities stated above. [A02] [A04] [A07] [A08] [A09] | Personal Shared onboarding says free/no card; that copy is not generalized to every shared sandbox. Account Limits exposes the shared and eager limits separately but counts one combined shared/dedicated population. [A05] [A06] [A08] [A09] | No `agent_billing_records` for shared hosting. Standard shared inference uses the deferred Worker or compatibility credit ledger; Personal Shared does not debit the organization-credit ledger. [A02] [A07] [A08] [A09] [I03] [I08] [I09] | Standard shared Worker deferred settlement records actual usage, while compatibility reservation reconciliation returns unused reservation; Personal Shared has no organization-credit settlement. Stripe reversal policy for paid organization funding remains **UNKNOWN** pending [#22930][i22930], with server authority **[U19]** and UI/receipt exposure **[U15b]**. [A07] [A08] [A09] [I03] [I08] [I09] | Permanent implementation owner **UNKNOWN [U14]**. |
| Dedicated agents | Current constants: running $0.01/hour; stopped with snapshot $0.0025/hour. Creation/resume requires more than $0.10; shared→dedicated upgrade requires $0.72 runway. Sleeping/frozen retention economics and conflicting `$0/hour` UI are **UNKNOWN [U13]**. [D01] [D02] | Prorated elapsed hour by recorded compute-rate segments; snapshot-retention unit is **UNKNOWN [U13]**. [D01] [D03] | Tier is derived when configuration requires dedicated runtime; credit/runway gates apply. [A01] [D01] | Eager/dedicated admission uses the balance-derived 5/20/100/500 ceiling (below $1 / at $1 / at $10 / at $100) against the same combined non-terminal, non-pool sandbox population as shared admission. [A03] [A04] [A06] | Billable selector plus the combined sandbox count, `last_billed_at`, state/rate segments, and total billed. [A03] [A06] [D03] | No clock reset; `last_billed_at` advances after settlement. [D03] | The hourly billing transaction locks the sandbox/org, rejects shared/deletion-in-flight rows, debits atomically, and records the billing period. Standard and coding creation paths use the sandbox quota authority, but managed-Discord and eliza-app provisioning gaps remain tracked by [#23003][i23003]. The deletion guard is already in the audited baseline; [#22553][i22553] owns remaining live/prod biller proof, not that merged predicate. [A04] [D03] | Pricing surfaces show running rates; one badge says sleeping is $0, which must not be treated as retention policy. **UNKNOWN [U13]**. [D02] | `agent_billing_records` linked to `credit_transactions`, with rate segments. [D03] | Frozen/sleeping retention remains **UNKNOWN [U13]**, adjacent to [#20726][i20726]. Stripe reversal/resource-hold policy is pending [#22930][i22930], with server authority **[U19]** and UI/receipt exposure **[U15b]**. | Active bounded live/prod slice: [#22553][i22553]. Permanent owner **UNKNOWN [U14]**. |
| Containers | Implemented running-price constants include $0.67/base-instance day (~$20/month), resource-scaled with 20% markup. The catalogue also advertises deployment, image, storage, bandwidth, and extra-instance charges without an audited billing caller: **UNKNOWN [U07]**. [N01] [N02] | Prorated running day, scaled by desired count/CPU/memory. Units for the additional advertised charges are **UNKNOWN [U07]** until each is either metered or removed. [N01] [N02] | Organization credits; optional pay-from-earnings setting. **CONTRADICTION:** policy and UI promise earnings-first, but transaction code applies credits first. **UNKNOWN [U02]**. [N03] [N04] [N05] | Balance-derived ceiling 1/5/25/100 (free/starter/professional/enterprise), with optional organization override. [N01] [N06] | Active container count, `last_billed_at`, credit balance, and redeemable earnings balance. [N02] [N06] | No periodic quota reset; billing advances elapsed-time cursor. [N02] [N06] | The organization-cap count and insert are atomic, but that creation authority does not itself debit an advertised deployment charge; cron later settles prorated hosting. Same-project creation and app-deploy single-flight are not enforced by the atomic cap authority, and late quota rejection can surface incorrectly; [#23004][i23004] owns those bounded gaps. Settlement ordering currently contradicts policy/UI. [N02] [N04] [N06] | Pay-as-you-go card explicitly promises earnings before credits. [N05] | `container_billing_records`, `credit_transactions`, and `redeemable_earnings_ledger`. [N04] | Failed atomic settlement does not partially debit. Stripe reversal/resource-hold policy is pending [#22930][i22930], with server authority **[U19]** and UI/receipt exposure **[U15b]**. [N04] | Permanent implementation owner **UNKNOWN [U14]**. |
| API keys | **UNKNOWN [U08]**: no per-key price is enforced or documented in the audited create/auth path. Related lifecycle work [#22551][i22551] and [#22920][i22920] does not decide price. [K01] [K02] | **UNKNOWN [U08]**: stored `rate_limit` has no authoritative time unit in runtime enforcement. [K01] [K02] | Authenticated organization user may create a key; provisioner-reserved names are rejected. [K02] | Caller may store 1–100,000 (default 1,000), but runtime enforcement and organization key-count cap are **UNKNOWN [U08]**. [K01] [K02] [K07] | `usage_count` is telemetry, debounced once/minute/process; it is not an exact quota counter. [K03] | No authoritative rate window or usage reset. **UNKNOWN [U08]**. [K01] [K03] | Create route has auth/validation but no price or count gate; no audited runtime consumer establishes enforcement of the stored rate. **UNKNOWN [U08]**. [K02] | API Keys surface lists, creates, and revokes keys and shows status/recency. Server records contain stored usage/rate fields, but the current display mapper drops them and the UI does not render them. [K04] [K05] [K06] | No dedicated billing ledger; downstream billable calls use their own ledger. [K02] | No key-creation charge to refund is established; downstream refund rules apply. **UNKNOWN [U08]**. | Permanent implementation owner **UNKNOWN [U14]**. |
| One-off top-ups | Custom Stripe checkout charges exact dollars and grants the same numeric balance amount. API allows $1–$1,000; UI allows $1–$10,000; summary says $5 minimum. Stored credit-pack economics have no authoritative seed contract. **UNKNOWN [U11]**. [C02] [C03] [C06] [T01] | USD card charge in cents → USD balance unit; public “credits” naming remains **UNKNOWN [U01]**. [C02] | Successful provider payment/order settlement; fixed x402 endpoints also expose $10/$50/$100 top-ups. [T02] [T04] [T05] [T03] [T06] | Conflicting custom min/max noted under Price; pack set and minimum are **UNKNOWN [U11]**. [C02] [C03] [C06] [T01] | Stripe uses a durable checkout order, provider identity, and balance revision; x402 uses the settled network transaction identity and balance revision. [T03] [T06] | None; each Stripe order or x402 transaction is independently idempotent. [T03] [T06] | Stripe pins charge/grant in an exact-once checkout order before ledger mutation. x402 settles first, then grants through an idempotency key derived from network and transaction identity. [T03] [T06] | Billing tab custom-amount form; current client max conflicts with API max. [C06] | Stripe: `stripe_checkout_orders` linked to `credit_transactions`. x402: `credit_transactions` with the network transaction identity, no Stripe order. [T03] [T06] | Stripe reversal policy is pending [#22930][i22930], with server authority **[U19]** and UI/receipt exposure **[U15b]**; direct-crypto refund/overpayment policy is **UNKNOWN [U16]**. | Permanent implementation owner **UNKNOWN [U14]**. |
| Auto top-up | Configured credited amount $1–$1,000. With affiliate attribution, card charge adds affiliate markup and a 20% platform fee while the configured amount is credited; canonical customer presentation of that surcharge is **UNKNOWN [U18]**. [AT01] [AT06] | USD card charge in cents → USD balance unit. [AT01] | Organization opt-in, threshold/amount, usable saved payment method, durable database control plane, and runtime flag exactly `true`. Production activation is human/operator-gated. [AT01] [AT02] | Threshold $0–$1,000; amount $1–$1,000; one blocking attempt per organization with leases/retries. [AT01] [AT03] | Durable `auto_top_up_attempts` state machine, lease, provider/payment identity, and linked credit transaction. [AT03] | No clock reset; after a success, re-arm requires a later balance decrease below threshold. [AT02] | Code path exists but remains disabled unless the env flag and durable-store cutover are approved; config intentionally omits the flag. Do not claim production activation. [AT01] [AT02] [AT04] | Billing card edits enablement, threshold, and amount and reports payment-method availability; payment-method management lives elsewhere. Surcharge disclosure remains **UNKNOWN [U18]**. [AT05] | `auto_top_up_attempts` linked to `credit_transactions` and provider payment intent. [AT03] | Stripe reversal behavior remains human-gated in [#22930][i22930], with server implementation tracked in **[U19]** and UI/receipt exposure in **[U15b]**. | Active durable/cutover slice [#20717][i20717] plus named human operator approval; permanent owner **UNKNOWN [U14]**. |
| Earnings/redemptions | Earned balance is USD-denominated and redemption uses 100 points = $1. The default USDC path pays that USD value 1:1 with no safety spread; legacy ELIZA-token/TWAP quotes apply a 2% safety spread. Configured fees are zero. [E01] [E02] [E03] [E13] | Implementation uses a redeemable USD balance and integer points (one point = $0.01); the canonical external earnings unit is **UNKNOWN [U09]**. [E01] [E02] [E06] | A repository-authenticated user principal associated with an active organization, with available earnings and a valid payout address. This public matrix makes no claim about the canonical payout-initiation role/credential policy; details are routed under repository `SECURITY.md`. Every request requires later admin approval. Legacy ELIZA inventory is checked at request admission; default USDC inventory is checked by the payout processor before broadcast. [E16] [E17] [E18] | Observed-state preflight checks cover 100–100,000 points ($1–$1,000), one in-flight request, 5-minute user cooldown, 10 requests/$5,000 per user per UTC day, and per-IP 5/hour plus 15/$2,000 per rolling day. This public matrix makes no claim about concurrent-admission guarantees; details are routed under repository `SECURITY.md`. All requests require admin approval. The mounted CRITICAL preset is nominally 5 requests/5 minutes but is not fail-closed at the audited commit; [#22982][i22982] owns that public residual. The exported user-hourly constant is exposed in quote/balance responses but has no audited enforcement consumer. Exported system-hourly/daily, 10-per-5-minute, and 24-hour pending-age constants have no audited runtime consumer and are not asserted as limits. [E02] [E03] [E04] [E07] [E08] [E09] [E10] [E14] [E15] | Available/pending/lifetime earnings, immutable earnings ledger, token-redemption state, and observed route/IP/user-day counters. [E01] [E07] [E09] [E10] | Code observes a five-minute user cooldown, UTC-day user counters, and rolling one-hour/24-hour IP windows. The mounted route window is five minutes but remains fall-open pending [#22982][i22982]; runtime reset/expiry for dormant constants is not asserted. [E08] [E09] [E10] [E14] [E15] | At request creation, the service applies its observed-state gates, idempotency, legacy-ELIZA liquidity check, atomic earnings reservation, and admin-review setup. For default USDC, the payout processor checks hot-wallet inventory after approval and immediately before broadcast. This public matrix makes no claim about concurrent-admission guarantees; details are routed under repository `SECURITY.md`. The mounted route limiter remains fall-open pending [#22982][i22982]. **CONTRADICTION:** UI sends/query `amount`, while quote and POST APIs require `pointsAmount`; UI also expects stale quote field names. **UNKNOWN [U03]**. [E02] [E04] [E05] [E07] [E08] [E09] [E10] [E14] [E15] [E16] [E17] [E18] [E19] | Earnings page currently uses the incompatible `amount` contract, so quote/submit flow is not authoritative until **U03** is fixed. [E05] | `redeemable_earnings`, immutable `redeemable_earnings_ledger`, `token_redemptions`, and `redemption_limits`. [E01] [E06] [E07] [E10] | An admin-rejected redemption, or a terminally failed redemption that is provably unbroadcast, can restore earnings through an idempotent ledger refund. Broadcast-but-unconfirmed payouts remain for reconciliation. The effect of a reversed source payment on attributed earnings or an in-flight/completed payout is **UNKNOWN [U20]**. [E11] [E12] | Permanent implementation owner **UNKNOWN [U14]**; API/UI repair needs a dedicated issue **[U03]**. |

## UNKNOWN register

An adjacent issue is listed only as context; it does **not** close the UNKNOWN unless
the dedicated issue explicitly owns the decision and lands an authoritative contract.

| ID | Unresolved contract | Evidence / contradiction | Tracking and gate |
| --- | --- | --- | --- |
| [U01] | **RESOLVED — `credit-unit-usd-vs-100`:** one organization cloud credit equals $1 USD across checkout, API, UI, docs, and new MCP price fields. | Existing balances/checkouts were already 1:1. Legacy user-MCP pricing points remain stored at 100 points per dollar and are explicitly converted at the boundary, so customer balances require no migration or backfill. [C01] [C02] [C03] [C04] [C08] | Implemented by [#22952][U01]. Decision B subscriptions [#20328][i20328] add a separate expiring allowance authority and do not change this purchased-credit unit. |
| [U02] | `container-earnings-first-order`: make policy, UI, plan, and transactional settlement use the same funding order. | Policy/UI earnings-first; repository credits-first. [N03] [N04] [N05] | Dedicated issue [#22951][U02]. |
| [U03] | `earnings-redemption-contract`: standardize query/body and response field names, then add UI↔route contract tests. | UI uses `amount`, `elizaPriceUsd`, `expiresAt`, and `safetySpread`; APIs require `pointsAmount` and return `twapPriceUsd`, `validUntil`, and `safetySpreadPercent`. [E02] [E04] [E05] | Dedicated issue [#22953][U03]. |
| [U04] | `canonical-billing-snapshot`: define one read model for balances, active billables, limits, payment state, and reset windows. | Current UI snapshots are capability-specific and explicitly omit some live usage/reset data. [I06] [S06] [A06] | Dedicated issue [#22954][U04]. |
| [U05] | `billing-purchase-settings-roles`: define which human/service/API-key roles may view history, initiate checkout, manage payment methods, configure/trigger auto top-up, cancel billables, and manage future subscription settings. | These purchase/settings authorities are distributed across route-local auth; payout initiation is not owned by this issue and is privately routed under `SECURITY.md`. | Dedicated issue [#22959][U05]. |
| [U06] | `storage-price-docs-fallback`: ratify storage units/prices and decide fail-closed versus fallback behavior. | Seed contains a pricing TODO; missing rows trigger a wrong-unit fallback that massively overcharges byte-bearing PUTs and charges GET-like operations above the seed; public docs use a third unit/rate. [S01] [S02] [S03] | Dedicated issue [#22956][U06]. [#21045][i21045] and [#22399][i22399] own production storage paths, not product pricing. |
| [U07] | `ghost-container-charges`: make every advertised deployment, image, storage, bandwidth, reference-instance, and extra-instance price either idempotently metered with a receipt or remove it from the product contract. | Constants advertise several charges, while the audited billing callers establish only running CPU/memory/count proration. [N01] [N02] | Dedicated issue [#22957][U07]. [#22553][i22553] remains the adjacent billing-selection goal and is not duplicated. |
| [U08] | `api-key-price-count-per-key-rate`: decide key price, org count ceiling, rate unit/window, exact counter, reset, and enforcement point. | Create stores caller-selected 1–100,000; usage counter is approximate telemetry; no creation price/count gate or runtime rate consumer is established. [K01] [K02] [K03] | Dedicated issue [#22958][U08]. [#22551][i22551] and [#22920][i22920] are lifecycle/revocation only. |
| [U09] | `earnings-usd-vs-points`: choose the canonical earnings/redemption unit and conversion/display rules. | Earnings ledger is USD-denominated while redemption HTTP uses integer points at one cent each. [E01] [E02] | Dedicated issue [#22960][U09]. |
| [U10] | `mcp-dual-settlement`: define the funding invariant for buyer debit/credit, platform fee, and creator redeemable earnings so one MCP purchase cannot mint duplicate value. | The MCP settlement path can affect both organization credits and creator earnings; the audit found no durable product decision proving whether this is an intentional two-sided transfer or duplicate value. [C08] | Dedicated issue [#22961][U10]. |
| [U11] | `credit-pack-seeds-min-topup`: choose the authoritative pack set and one-off top-up minimum/maximum. | Checkout, summary, and UI disagree; schema is data-driven without a canonical seed in this audit. [C02] [C03] [C06] [T01] | Dedicated issue [#22963][U11]. [#20717][i20717] owns durable auto top-up, not pack pricing. Affiliate auto-top-up disclosure is separate **[U18]**. |
| [U12] | `weekly-inference-enforcement`: decide whether weekly quotas launch and wire atomic check/track/reset if they do. | Weekly service methods exist, but the audited inference flow establishes RPM plus organization-credit admission/settlement, not production weekly-quota enforcement. [I04] [I05] [I08] [I09] [I11] [I12] [I13] | Dedicated issue [#22962][U12]. [#20328][i20328] is a human subscription-model decision, not quota wiring. |
| [U13] | `sandbox-frozen-retention-economics`: define sleeping/frozen snapshot retention, restoration, deletion, and billing states. | Billing constants charge stopped snapshots; UI says sleeping is $0; selector only bills stopped rows with backups. [D01] [D02] [D03] | Dedicated issue [#22967][U13]. [#20726][i20726] is adjacent retention/GC work; [#22553][i22553] owns current biller hardening, not policy. |
| [U14] | `billing-implementation-ownership`: name durable code owners and escalation paths per capability. | [#22942][i22942] is docs-only; active issue assignees are not permanent subsystem ownership. | Dedicated issue [#22964][U14]. |
| [U15a] | `active-billables-ui`: expose a canonical, auditable list of currently billable resources and their rates/states. | Current UI is split across capability cards and does not provide one authoritative active-billables view. [I06] [S06] [A06] | Dedicated issue [#22965][U15a]. |
| [U15b] | `refunds-payment-states-ui`: render the ratified provider-neutral receipt, hold, restoration, and payment states consistently across billing surfaces. | Current surfaces do not expose one authoritative customer-visible reversal state; this issue is UI-only and does not execute refunds or server holds. | Dedicated issue [#22966][U15b], blocked on human decision [#22930][i22930] and server authority **[U19]**. |
| [U16] | `direct-crypto-refund-overpayment`: define overpayment, duplicate, refund, and entitlement handling for direct/x402 crypto top-ups. | Exact-once x402 crediting does not itself define provider/direct-crypto refund policy. [T02] [T04] [T05] [T06] | Dedicated issue [#22968][U16]. [#22327][i22327] and [#22850][i22850] are adjacent but do not own provider/direct-crypto reversal policy. |
| [U17] | `inference-tier-credit-sources`: ratify which purchase, grant, adjustment, and reversal provenances qualify the existing $5/$100 RPM thresholds. | Runtime derives qualification from credit-ledger history, but implementation labels do not establish the intended economic policy. [I04] [I10] | Dedicated human decision [#23019][U17]. Weekly quotas [#22962][U12], launch model [#20328][i20328], and reversals [#22930][i22930] remain separate. |
| [U18] | `affiliate-auto-topup-disclosure`: define the server-owned fields, copy, timing, receipt, and accessibility contract for the existing affiliate surcharge. | The durable attempt can charge more than the configured credited base amount, but the current settings card does not establish the total-charge disclosure contract. [AT05] [AT06] | Dedicated human decision [#23020][U18]. Formula and protected activation remain unchanged under [#20717][i20717]. |
| [U19] | `stripe-reversal-hold-authority`: implement the ratified server-side Stripe reversal, billing-hold, resource-transition, and restoration policy. | [#22930][i22930] is the product decision; [#22966][U15b] is UI-only and does not own server enforcement or ledger mutation. | Dedicated human-blocked implementation issue [#23021][U19], blocked on [#22930][i22930]. |
| [U20] | `creator-earnings-source-reversal`: decide how an authoritative source-payment reversal affects attributed earnings and redemptions in every state. | Organization credit/entitlement reversal policy does not decide creator loss allocation, payout holds/debt, or restoration after downstream value was attributed. | Dedicated human decision [#23022][U20]. Organization holds [#22930][i22930]/[U19], MCP funding [#22961][U10], and UI [#22966][U15b] remain separate. |

## Atomic creation residuals found after the matrix inventory

These are bounded implementation-correctness gaps in existing limits, not new
pricing or entitlement decisions, so they do not receive `Uxx` decision identifiers.
They are listed here to prevent the capability rows from overstating enforcement.

| Existing invariant | Exact residual | Tracking |
| --- | --- | --- |
| Organization Cloud-character ceiling | Some authenticated creation paths check a replica before a later insert, while the shared creation authority itself does not serialize the organization count and insert. | [#23001][i23001] |
| Shared non-terminal sandbox ceiling | Standard and coding paths use the atomic authority; managed-Discord and eliza-app provisioning paths do not yet compose with it consistently. | [#23003][i23003] |
| Active-container organization ceiling | The global count/insert is atomic, but same-project and app-deploy intent single-flight plus canonical late quota rejection remain separate gaps. | [#23004][i23004] |

## Human and production gates preserved by this inventory

- [#20328][i20328] ratifies Decision B: $30 Plus and $100 Pro with separate,
  non-rollover monthly allowances. The decision is complete, but implementation
  remains dependency-ordered work [#23090][i23090]–[#23097][i23097]. Draft
  catalog PR [#23154][p23154] is not production activation.
- [#20956][i20956] is an open human decision for generated-media charging when
  storage quota enforcement rejects or later removes an object.
- [#22930][i22930] is an open human decision for Stripe refunds, disputes,
  chargebacks, entitlement clawback, resource holds, and customer-visible state.
  Server implementation [U19] and UI/receipt work [U15b] remain blocked on it;
  creator-earnings/source-payment reversal policy is separately [U20].
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
- **Inference:** [I01] price catalog; [I02] exact/flat fail-closed lookup; [I03]
  compatibility reservation/reconciliation; [I04] ledger-derived RPM tiers/window;
  [I05] weekly quota service; [I06] UI snapshot limitation; [I07] token-price fallback
  ladder; [I08] Worker/compatibility admission modes; [I09] production Worker mode
  flags; [I10] active RPM enforcement; [I11]/[I12]/[I13] active chat, embeddings,
  and shared-generative callers for rate and deferred admission.
- **Storage:** [S01] quota/pricing migration; [S02] missing-price fallback; [S03]
  public docs; [S04] atomic quota repository; [S05] billed PUT route; [S06] UI scope;
  [S07] billed DELETE route.
- **Agents:** [A01] tier derivation; [A02] hosting selector; [A03] shared ceiling;
  [A04] create path; [A05] Personal Shared onboarding copy; [A06] account snapshot;
  [A07] standard shared REST organization-credit funding; [A08] platform-funded
  execution behavior; [A09] canonical Personal Shared caller selecting platform
  funding. Dedicated: [D01] prices/gates; [D02] UI; [D03] atomic
  biller and ledger.
- **Containers:** [N01] prices/limits; [N02] cron proration; [N03] funding policy;
  [N04] transactional settlement; [N05] UI promise; [N06] organization-quota
  count/insert authority and separate unused debit-capable repository path.
- **API keys:** [K01] schema; [K02] create route; [K03] approximate usage
  counter; [K04] client response shape/load; [K05] display mapper; [K06]
  list/create/revoke UI; [K07] create-input bounds/default.
- **Top-ups:** [T01] data-driven packs; [T02]/[T04]/[T05] fixed direct top-ups;
  [T03] exact-once Stripe order settlement; [T06] x402 settlement/grant identity.
  Auto top-up: [AT01] bounds; [AT06] fee calculation; [AT02]
  cutover runbook; [AT03] attempt ledger; [AT04] omitted runtime flag; [AT05] UI.
- **Earnings:** [E01] earnings balance/ledger; [E02] redemption API/schema; [E03]
  exported security/fee configuration; [E04] quote contract; [E05] incompatible
  UI request/response; [E06] points-to-USD storage contract; [E07] service limit
  values; [E08] route limiter preset; [E09] mounted service gate sequence; [E10]
  daily and per-IP enforcement; [E11] admin rejection refund; [E12] terminal
  unbroadcast payout refund and broadcast reconciliation fence; [E13] asset
  pricing/payout branch; [E14] route limiter mounting; [E15] middleware outage
  behavior; [E16] route principal and service call; [E17] request-time asset liquidity;
  [E18] pre-broadcast hot-wallet inventory; [E19] validation, idempotency, earnings
  reservation, and admin-review setup.

[source]: https://github.com/elizaOS/eliza/tree/9edb8e24017b4675669e79ea6560b38a19aa8ec5
[C01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/credits.ts#L670-L676
[C02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/credits/checkout/route.ts#L35-L151
[C03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/credits/summary/route.ts#L171-L175
[C04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/docs/tracks/cloud/billing.mdx#L6-L8
[C05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/organizations.ts#L43-L59
[C06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/billing/components/billing-tab.tsx#L61-L492
[C07]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/credits.ts#L777-L922
[C08]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/user-mcps.ts#L521-L655
[C09]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/credit-transactions.ts#L17-L62
[I01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/ai-pricing.ts#L18-L50
[I02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/ai-pricing/lookup.ts#L44-L165
[I03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/ai-billing.ts#L316-L505
[I04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/org-rate-limits.ts#L42-L304
[I05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/usage-quotas.ts#L48-L269
[I06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/billing/components/account-limits-card.tsx#L492-L510
[I07]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/ai-pricing/lookup.ts#L190-L498
[I08]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/organization-inference-admission.ts#L229-L524
[I09]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/wrangler.toml#L781-L887
[I10]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/middleware/rate-limit.ts#L443-L488
[I11]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/chat/completions/route.ts#L1372-L1834
[I12]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/embeddings/route.ts#L187-L323
[I13]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/src/lib/generative-route-auth.ts#L90-L265
[S01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/migrations/0102_add_org_storage_quota.sql#L1-L38
[S02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/proxy/pricing.ts#L7-L89
[S03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/docs/cloud/billing.mdx#L53-L60
[S04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/repositories/org-storage-quota.ts#L12-L89
[S05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/apis/storage/objects/%5B...key%5D/route.ts#L96-L169
[S06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/billing/components/account-limits-card.tsx#L393-L441
[S07]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/apis/storage/objects/%5B...key%5D/route.ts#L302-L335
[A01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/shared-runtime/agent-tier.ts#L1-L74
[A02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/repositories/agent-billing.ts#L105-L148
[A03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/constants/agent-sandbox-quota.ts#L26-L54
[A04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/eliza/agents/route.ts#L344-L422
[A05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/eliza-app/onboarding-chat.ts#L169-L175
[A06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/account-limits-snapshot.ts#L231-L297
[A07]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/shared-runtime/shared-rest-adapter.ts#L528-L566
[A08]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/shared-runtime/shared-runtime-chat.ts#L830-L912
[A09]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/internal/eliza-app/personal-shared/messages/route.ts#L627-L636
[D01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/constants/agent-pricing.ts#L1-L48
[D02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/instances/components/agent-cost-badge.tsx#L1-L65
[D03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/repositories/agent-billing.ts#L296-L439
[N01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/constants/pricing.ts#L31-L219
[N02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/cron/container-billing/route.ts#L80-L108
[N03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/container-billing-policy.ts#L41-L81
[N04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/repositories/container-billing.ts#L300-L462
[N05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/billing/components/pay-as-you-go-card.tsx#L105-L137
[N06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/repositories/containers.ts#L724-L875
[K01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/api-keys.ts#L16-L62
[K02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/api-keys/route.ts#L61-L144
[K03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/api-keys.ts#L62-L69
[K04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/api-keys/use-api-keys.ts#L16-L47
[K05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/api-keys/ApiKeysSurface.tsx#L33-L95
[K06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/api-keys/ApiKeysView.tsx#L90-L210
[K07]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/api-keys/schemas.ts#L18-L29
[T01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/credit-packs.ts#L14-L41
[T02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/topup/10/route.ts#L20-L36
[T04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/topup/50/route.ts#L20-L36
[T05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/topup/100/route.ts#L20-L36
[T03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/stripe-checkout-orders.ts#L454-L520
[T06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/topup-handler.ts#L395-L454
[AT01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/auto-top-up.ts#L36-L55
[AT02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/docs/auto-top-up-durable-cutover.md#L12-L26
[AT03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/auto-top-up-attempts.ts#L53-L162
[AT04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/wrangler.toml#L199-L205
[AT05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/billing/components/auto-top-up-card.tsx#L408-L510
[AT06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/auto-top-up.ts#L1049-L1111
[E01]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/redeemable-earnings.ts#L68-L250
[E02]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/redemptions/route.ts#L27-L41
[E03]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/config/redemption-security.ts#L12-L149
[E04]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/redemptions/quote/route.ts#L34-L227
[E05]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/ui/src/cloud/monetization/earnings/EarningsPageClient.tsx#L97-L286
[E06]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/db/schemas/token-redemptions.ts#L64-L213
[E07]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L67-L148
[E08]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/middleware/rate-limit-hono-cloudflare.ts#L721-L730
[E09]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L388-L419
[E10]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L840-L994
[E11]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L1190-L1273
[E12]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/payout-processor.ts#L1077-L1242
[E13]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L258-L470
[E14]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/redemptions/route.ts#L65-L75
[E15]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/middleware/rate-limit-hono-cloudflare.ts#L563-L688
[E16]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/api/v1/redemptions/route.ts#L88-L198
[E17]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L445-L494
[E18]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/payout-processor.ts#L740-L913
[E19]: https://github.com/elizaOS/eliza/blob/9edb8e24017b4675669e79ea6560b38a19aa8ec5/packages/cloud/shared/src/lib/services/token-redemption-secure.ts#L282-L672

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
[i22982]: https://github.com/elizaOS/eliza/issues/22982
[i23001]: https://github.com/elizaOS/eliza/issues/23001
[i23003]: https://github.com/elizaOS/eliza/issues/23003
[i23004]: https://github.com/elizaOS/eliza/issues/23004
[i23090]: https://github.com/elizaOS/eliza/issues/23090
[i23091]: https://github.com/elizaOS/eliza/issues/23091
[i23092]: https://github.com/elizaOS/eliza/issues/23092
[i23093]: https://github.com/elizaOS/eliza/issues/23093
[i23094]: https://github.com/elizaOS/eliza/issues/23094
[i23095]: https://github.com/elizaOS/eliza/issues/23095
[i23096]: https://github.com/elizaOS/eliza/issues/23096
[i23097]: https://github.com/elizaOS/eliza/issues/23097
[p23154]: https://github.com/elizaOS/eliza/pull/23154

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
[U17]: https://github.com/elizaOS/eliza/issues/23019
[U18]: https://github.com/elizaOS/eliza/issues/23020
[U19]: https://github.com/elizaOS/eliza/issues/23021
[U20]: https://github.com/elizaOS/eliza/issues/23022
