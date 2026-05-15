# Nullish Operator Audit Report

Generated: 2026-05-15T16:10:37.763Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 921 |
| Operators found | 15102 |
| Type-obvious removable | 4 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 2210 |
| `binary-&&` | 3019 |
| `binary-\|\|` | 2395 |
| `non-null-assertion` | 1 |
| `optional-chain` | 2329 |
| `optional-declaration` | 5148 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 5375 |
| `truthy-left-review` | 39 |
| `type-obvious-removable` | 4 |
| `type-required-or-unknown` | 4536 |
| `upstream-type-review` | 5148 |

## Type-Obvious Removable Examples

- `packages/ui/src/state/useOnboardingCallbacks.ts:568:50` optional-chain: runtimeConfig.serviceRouting?.tts?.backend
  - receiver type excludes null and undefined; type: `ServiceRouteConfig`
- `packages/ui/src/state/useOnboardingCallbacks.ts:568:45` optional-chain: runtimeConfig.serviceRouting?.tts
  - receiver type excludes null and undefined; type: `Partial<Record<ServiceCapability, ServiceRouteConfig>>`
- `packages/ui/src/state/useOnboardingCallbacks.ts:726:48` optional-chain: runtimeConfig.serviceRouting?.tts?.backend
  - receiver type excludes null and undefined; type: `ServiceRouteConfig`
- `packages/ui/src/state/useOnboardingCallbacks.ts:726:43` optional-chain: runtimeConfig.serviceRouting?.tts
  - receiver type excludes null and undefined; type: `Partial<Record<ServiceCapability, ServiceRouteConfig>>`
