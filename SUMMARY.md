# Pagination validation summary

All four staged routes had fail-open or non-canonical pagination defects and were modified.

- `billing-ledger-route.ts`: defective. Its finite-number fallback still accepted zero, negative, fractional, and oversized limits. It now accepts only canonical decimal integers from 1 through 500, defaults blank or missing input to 50, and returns a parameter/value-specific 400 otherwise. The staged route has no `offset` query handling, so none was invented.
- `ballots-route.ts`: defective. Zod coercion accepted exponent and leading-zero forms and mishandled blank input. Local parsing now enforces limit 1–500 and nonnegative safe-integer offset, with defaults 50 and 0, before the remaining filters are validated.
- `oauth-intents-route.ts`: defective for the same coercion behavior as ballots. It now uses the same fail-closed grammar and bounds, with defaults 50 and 0.
- `gallery-route.ts`: defective. In addition to coercion issues, its 1000-record ceiling exceeded the required 500. It now caps accepted limits at 500, defaults to 100/0, and retains the existing one-extra-record fetch used to calculate `hasMore`.

`v1-pagination-validation.test.ts` uses Bun module mocks before dynamic route imports and exercises malformed, negative, oversized/unsafe, junk, valid, and blank inputs at the HTTP boundary and mocked service boundary. `verify-pagination.mjs` is dependency-free and checks parser behavior plus forbidden source patterns.

Validation in this isolated stage: `node verify-pagination.mjs` passed, and Node 24's TypeScript syntax checker accepted all four routes and the Bun test file. Bun is not installed in the sandbox, so the mocked route suite could not be executed here.
