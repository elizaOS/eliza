# Nullish Operator Audit Report

Generated: 2026-05-15T10:26:04.487Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 291 |
| Operators found | 6023 |
| Type-obvious removable | 7 |
| Applied edits | 7 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 1136 |
| `binary-&&` | 974 |
| `binary-\|\|` | 1190 |
| `non-null-assertion` | 2 |
| `optional-chain` | 997 |
| `optional-declaration` | 1724 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 2157 |
| `truthy-left-review` | 7 |
| `type-obvious-removable` | 7 |
| `type-required-or-unknown` | 2128 |
| `upstream-type-review` | 1724 |

## Type-Obvious Removable Examples

- `packages/app-core/platforms/electrobun/src/native/desktop.ts:1632:36` optional-chain: Utils.isDockIconVisible?.()
  - receiver type excludes null and undefined; type: `() => boolean`
- `packages/app-core/platforms/electrobun/src/native/desktop.ts:1845:50` optional-chain: Utils.clipboardAvailableFormats?.()
  - receiver type excludes null and undefined; type: `() => string[]`
- `packages/app-core/src/services/sensitive-requests/owner-app-inline-adapter.ts:97:83` optional-chain: request.target?.kind
  - receiver type excludes null and undefined; type: `SensitiveRequestPrivateInfoTarget \| SensitiveRequestPaymentTarget \| SensitiveRequestOauthTarget`
- `packages/app-core/src/services/sensitive-requests/owner-app-inline-adapter.ts:191:83` optional-chain: request.target?.kind
  - receiver type excludes null and undefined; type: `SensitiveRequestPrivateInfoTarget \| SensitiveRequestPaymentTarget \| SensitiveRequestOauthTarget`
- `packages/app-core/scripts/runtime-package-manifest.ts:58:20` optional-chain: scopedName?.startsWith
  - receiver type excludes null and undefined; type: `string`
- `packages/app-core/src/services/phrase-chunked-tts.ts:148:55` optional-chain: globalThis.performance?.now?.()
  - receiver type excludes null and undefined; type: `() => number`
- `packages/app-core/src/services/phrase-chunked-tts.ts:148:50` optional-chain: globalThis.performance?.now
  - receiver type excludes null and undefined; type: `Performance`
