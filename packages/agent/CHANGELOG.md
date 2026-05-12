# Changelog

All notable changes to `@elizaos/agent` are documented here. This file follows the same “Unreleased + **Why**” style as `@elizaos/core` / `@elizaos/typescript` changelogs so intent stays visible next to the diff.

## Unreleased

### Added

- **x402 seller middleware** (`src/middleware/x402/`): paid plugin routes (`x402` on `Route`), startup validation, replay protection (durable SQL path when available), facilitator ID verification, and standard **PAYMENT-SIGNATURE** / **X-Payment** flows with facilitator **POST `/verify`** then **POST `/settle`** before the route handler runs.
  - **Why:** Operators need one place in the agent package to monetize HTTP plugin APIs without forking payment logic per plugin; facilitator-backed flows match how real buyers (e.g. `@x402/fetch`, CDP-style wallets) expect to pay.

- **402 dual surface:** JSON body (x402scan-style `accepts`, `x402Version: 1`) **plus** `PAYMENT-REQUIRED` header (base64 JSON, `x402Version: 2`, CAIP-2 networks) on payment-required responses.
  - **Why:** Existing integrations and scanners expect the JSON shape; protocol V2 clients expect header-based `PaymentRequired`. Shipping both avoids breaking older readers while still “speaking standards” to new clients.

- **`PAYMENT-RESPONSE` header** on successful standard paid requests (base64 JSON of the facilitator settle body when available).
  - **Why:** Buyers and tooling use the settlement header for receipts, retries, and debugging; exposing it keeps the agent compatible with documented client flows.

- **Mintlify docs:** `plugins/x402-paid-routes`, `plugins/x402-roadmap`, nav + cross-links from webhooks/routes.
  - **Why:** Payment behavior is policy-heavy; prose next to diagrams and env tables belongs in the docs site, not only in code comments.

- **Tests:** middleware unit tests + `runtime-plugin-routes-x402` integration-style coverage for 402, double-wrap guard, and standard verify+settle.
  - **Why:** Payment regressions are security-sensitive; tests lock the intended order of operations (verify → settle → handler).

### Changed

- **Default facilitator base** for standard flows: `https://x402.elizacloud.ai/api/v1/x402` with `/verify` and `/settle` appended unless overridden (`X402_FACILITATOR_URL`, `X402_FACILITATOR_VERIFY_URL`, `X402_FACILITATOR_SETTLE_URL`).
  - **Why:** A single obvious default lowers setup friction; explicit overrides exist because hosted facilitators differ in path layout.

### Notes

- **Legacy EIP-712 “proof only” path** remains gated by `X402_ALLOW_EIP712_SIGNATURE_VERIFICATION` because local signature verification does not prove settlement.
  - **Why:** Without a facilitator or on-chain proof, turning that on would reintroduce the “authorize but never pay” footgun.
