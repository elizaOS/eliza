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

## Tiers

- **validated** — a recorded-real contract test (replays a captured real response
  through the real parser) AND a live-drift test (re-fetches the live API). The
  strongest tier; needs a public API.
- **contract-tested** — a recorded-real contract test only (the parser is proven
  against a captured real response). No live-drift yet (key-gated, or the live
  call is awkward to make in CI).
- **researched-fixed** — the shape was verified against the provider's current
  docs/schema and a real bug fixed, but there's no recorded-replay harness yet
  (the call isn't injectable).
- **validated-elsewhere** — covered by a different real-backend harness.
- **unvalidated** — inline fixtures only; no tie to the real API. The debt set.

## Ledger

| External API | Provider host | Public? | Tier | Evidence / next step |
|---|---|---|---|---|
| Polymarket | gamma/clob/data-api.polymarket.com | yes | **validated** | `plugin-polymarket-app/src/routes.{contract,real}.test.ts`. Fixed UI mock `liquidity` format. |
| Hyperliquid | api.hyperliquid.xyz/info | yes | **validated** | `plugin-hyperliquid-app/src/routes.{contract,real}.test.ts`. |
| ClawVille | api.clawville.world | yes | **contract-tested** | `plugin-clawville/src/routes.test.ts` (recorded REAL_CONNECT/perception). Fixed stale building ids via perception-aware resolution. Next: live-drift test. |
| Defense of the Agents | defenseoftheagents.com | yes | **contract-tested** | `plugin-defense-of-the-agents/src/routes.contract.test.ts`. Next: live-drift. |
| Scape | scape backend | partial | **contract-tested** | `plugin-scape/src/routes.telemetry.test.ts` (real-shaped telemetry parser). |
| Shopify | Admin GraphQL 2025-04 | no (store token) | **contract-tested** | `plugin-shopify-ui/src/routes.contract.test.ts` + customer fields fixed to `numberOfOrders`/`amountSpent` (verified vs live 2025-04 docs). Next: gated live-refresh. |
| Steward | KMS/anvil bridge | no | **contract-tested** | `plugin-steward-app/src/steward-bridge.contract.test.ts`. |
| Vincent | heyvincent.ai OAuth | no (OAuth) | **contract-tested** | `plugin-vincent/src/vincent-oauth-parser.contract.test.ts`. Next: gated live OAuth-profile capture. |
| CoinGecko | api.coingecko.com | yes | **validated** | `plugin-wallet/src/routes/wallet-market-overview.{contract,real}.test.ts` — recorded `/coins/markets` replayed through the real route + live-drift. (plugin-social-alpha's coingecko use is still inline.) |
| Eliza Cloud | cloud-api worker | n/a | **validated-elsewhere** | `packages/test/cloud-e2e` boots the real cloud-api worker. |
| Block explorers | bscscan/etherscan/solscan | yes (key for some) | **unvalidated** | `plugin-wallet`, `plugin-steward-app`. Public read endpoints → recorded contract test (next cheapest win). |
| Wallet RPC | EVM/Solana RPC + token providers | partial | **unvalidated** | Inline DTO fixtures, no recorded-real tie. |
| ElevenLabs | api.elevenlabs.io | no (key) | **unvalidated** | TTS/STT; gated recorded fixture + live-refresh. |
| Calendly | api.calendly.com | no (key) | **unvalidated** | `plugin-calendly`; gated recorded fixture. |
| Strava | www.strava.com | no (OAuth) | **unvalidated** | gated recorded fixture. |
| Google (Calendar/Gmail/Drive/YouTube) | googleapis.com | no (OAuth) | **unvalidated** | gated recorded fixtures per surface. |
| Web search | provider-dependent | no (key) | **unvalidated** | `plugin-web-search`; gated recorded fixture. |

## Ratchet

`test/external-api-mock-validation.test.ts` enforces three things:
1. every **validated** API keeps its `routes.contract.test.ts` + `routes.real.test.ts`;
2. every **contract-tested** API keeps its recorded-contract test file; and
3. the **unvalidated** debt set only shrinks.

To advance an API a tier: capture a real response, add the recorded-contract test
(→ contract-tested), then add a live-drift/refresh test (→ validated), updating the
sets in the gate. Public + injectable APIs (CoinGecko, block explorers) are the
cheapest next wins.
