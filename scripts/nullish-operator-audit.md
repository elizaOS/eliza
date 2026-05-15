# Nullish Operator Audit Report

Generated: 2026-05-15T10:27:32.117Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 291 |
| Operators found | 6018 |
| Type-obvious removable | 2 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 1136 |
| `binary-&&` | 974 |
| `binary-\|\|` | 1190 |
| `non-null-assertion` | 2 |
| `optional-chain` | 992 |
| `optional-declaration` | 1724 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 2157 |
| `truthy-left-review` | 7 |
| `type-obvious-removable` | 2 |
| `type-required-or-unknown` | 2128 |
| `upstream-type-review` | 1724 |

## Type-Obvious Removable Examples

- `packages/app-core/src/services/sensitive-requests/owner-app-inline-adapter.ts:97:83` optional-chain: request.target?.kind
  - receiver type excludes null and undefined; type: `SensitiveRequestPrivateInfoTarget \| SensitiveRequestPaymentTarget \| SensitiveRequestOauthTarget`
- `packages/app-core/src/services/sensitive-requests/owner-app-inline-adapter.ts:191:83` optional-chain: request.target?.kind
  - receiver type excludes null and undefined; type: `SensitiveRequestPrivateInfoTarget \| SensitiveRequestPaymentTarget \| SensitiveRequestOauthTarget`
