# External-API mock validation — ledger + pattern

The app's keyless ui-smoke lane mocks every external-API BFF endpoint with inline
`page.route` fixtures in `test/ui-smoke/helpers.ts`. Those fixtures are hand-authored,
so without a tie to the real API they silently drift from it. This is the standing
answer to "are the external-API mocks validated against the real API?" and the
pattern for making a new one validated.

## The two boundaries

An external-API view plugin has two contract boundaries:

1. **UI ⇄ BFF** — the DTO the view consumes. The `helpers.ts` mock emulates this.
2. **BFF ⇄ provider** — the plugin's route handler parsing the real provider
   response into that DTO. This is the boundary that actually breaks when a
   provider changes its wire format.

A mock is only "validated" when the BFF parser is proven to produce the same
contract-shaped DTO from a **real recorded** provider response — and ideally a
live drift check confirms the recording is current.

## The validated pattern (per plugin)

1. `src/__fixtures__/<api>-real.recorded.json` — a real provider response captured
   from the live API (documented `_source` / `_captured`).
2. `src/__fixtures__/contract.ts` — structural validators for each BFF DTO
   (stricter than the TS interface where it matters, e.g. numeric strings).
3. `src/routes.contract.test.ts` — **keyless**: replays the recorded real response
   through the actual route handler (injected `fetchImpl`) and asserts a
   contract-shaped DTO. Runs in every PR lane.
4. `src/routes.real.test.ts` — **gated** (`<API>_LIVE_TEST=1` or
   `TEST_LANE=post-merge`): re-fetches the live API and asserts it still conforms,
   catching drift from the recording.
5. The `helpers.ts` mock fixture must produce a DTO that passes the same validator.

Requirement for the pattern: the route handler must accept an injectable
`fetchImpl` (Polymarket/Hyperliquid `*RouteState`). Plugins whose provider call is
not injectable need that refactor first.

## Ledger

| External API | Provider | Public? | Status | Evidence / debt |
|---|---|---|---|---|
| Polymarket | gamma/clob/data-api.polymarket.com | yes | **validated** | `plugins/plugin-polymarket-app/src/routes.{contract,real}.test.ts` — recorded + live. Fixed UI mock `liquidity` format. |
| Hyperliquid | api.hyperliquid.xyz/info | yes | **validated** | `plugins/plugin-hyperliquid-app/src/routes.{contract,real}.test.ts` — recorded + live. |
| Shopify | Admin GraphQL 2025-04 | no (needs store token) | **researched-fixed** | Customer fields fixed to `numberOfOrders`/`amountSpent` (verified vs live 2025-04 schema docs); product mock matched to handler. Debt: `shopifyGql` is not injectable — no recorded-replay harness yet. |
| Eliza Cloud | cloud-api worker | n/a | **validated elsewhere** | `packages/test/cloud-e2e` boots the real cloud-api worker; the `helpers.ts` cloud mock is a trivial `connected:false` shell. |
| Vincent | heyvincent.ai OAuth | no (OAuth) | **debt** | Only the unconfigured `connected:false` path is exercised; the real OAuth/profile response shape is unvalidated. |
| Wallet / RPC | EVM/Solana RPC + token providers | partial | **debt** | Inline DTO fixtures, no recorded-real tie. |

## Ratchet

`test/external-api-mock-validation.test.ts` enforces that every API marked
**validated** keeps its `routes.contract.test.ts` + `routes.real.test.ts`, and
bounds the **debt** set so it can only shrink. To pay down debt: make the plugin's
provider call injectable, add the four files above, flip the row to validated, and
remove it from the debt list in the test.
