# Nullish Operator Audit Report

Generated: 2026-05-15T13:44:09.387Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 77 |
| Operators found | 997 |
| Type-obvious removable | 3 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 188 |
| `binary-&&` | 160 |
| `binary-\|\|` | 230 |
| `optional-chain` | 243 |
| `optional-declaration` | 176 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 387 |
| `truthy-left-review` | 3 |
| `type-obvious-removable` | 3 |
| `type-required-or-unknown` | 428 |
| `upstream-type-review` | 176 |

## Type-Obvious Removable Examples

- `plugins/plugin-companion/src/components/avatar/retargetMixamoFbxToVrm.ts:19:29` optional-chain: vrm.meta?.metaVersion
  - receiver type excludes null and undefined; type: `VRMMeta`
- `plugins/plugin-companion/src/components/avatar/retargetMixamoGltfToVrm.ts:19:29` optional-chain: vrm.meta?.metaVersion
  - receiver type excludes null and undefined; type: `VRMMeta`
- `plugins/plugin-companion/src/components/companion/CompanionSceneHost.tsx:529:28` optional-chain: detail?.offset
  - receiver type excludes null and undefined; type: `{ offset: number; }`
