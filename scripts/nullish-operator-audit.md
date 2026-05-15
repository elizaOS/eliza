# Nullish Operator Audit Report

Generated: 2026-05-15T10:53:40.460Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 348 |
| Operators found | 10453 |
| Type-obvious removable | 4 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 1959 |
| `binary-&&` | 1922 |
| `binary-\|\|` | 1707 |
| `optional-chain` | 1974 |
| `optional-declaration` | 2891 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 3602 |
| `truthy-left-review` | 27 |
| `type-obvious-removable` | 4 |
| `type-required-or-unknown` | 3929 |
| `upstream-type-review` | 2891 |

## Type-Obvious Removable Examples

- `packages/agent/src/api/connector-account-routes.ts:863:38` binary-??: query.outcome ?? ""
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/api/connector-account-routes.ts:871:37` binary-??: query.accountId ?? ""
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/api/connector-account-routes.ts:872:31` binary-??: query.action ?? ""
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/api/views-routes.ts:122:26` optional-chain: body?.payload
  - receiver type excludes null and undefined; type: `Record<string, unknown>`
