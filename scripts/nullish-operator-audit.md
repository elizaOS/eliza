# Nullish Operator Audit Report

Generated: 2026-05-15T10:55:16.786Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 291 |
| Operators found | 6029 |
| Type-obvious removable | 5 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 1137 |
| `binary-&&` | 975 |
| `binary-\|\|` | 1197 |
| `non-null-assertion` | 2 |
| `optional-chain` | 994 |
| `optional-declaration` | 1724 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 2165 |
| `truthy-left-review` | 7 |
| `type-obvious-removable` | 5 |
| `type-required-or-unknown` | 2128 |
| `upstream-type-review` | 1724 |

## Type-Obvious Removable Examples

- `packages/app-core/src/services/sensitive-requests/owner-app-inline-adapter.ts:97:83` optional-chain: request.target?.kind
  - receiver type excludes null and undefined; type: `SensitiveRequestPrivateInfoTarget \| SensitiveRequestPaymentTarget \| SensitiveRequestOauthTarget`
- `packages/app-core/src/services/sensitive-requests/owner-app-inline-adapter.ts:191:83` optional-chain: request.target?.kind
  - receiver type excludes null and undefined; type: `SensitiveRequestPrivateInfoTarget \| SensitiveRequestPaymentTarget \| SensitiveRequestOauthTarget`
- `packages/app-core/src/services/phrase-chunked-tts.ts:148:60` binary-??: globalThis.performance?.now?.() ?? Date.now()
  - left-hand type excludes null and undefined; type: `number`
- `packages/app-core/src/services/phrase-chunked-tts.ts:148:55` optional-chain: globalThis.performance?.now?.()
  - receiver type excludes null and undefined; type: `() => number`
- `packages/app-core/src/services/phrase-chunked-tts.ts:148:50` optional-chain: globalThis.performance?.now
  - receiver type excludes null and undefined; type: `Performance`
