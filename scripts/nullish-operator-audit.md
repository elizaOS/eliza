# Nullish Operator Audit Report

Generated: 2026-05-15T09:50:21.444Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 363 |
| Operators found | 11975 |
| Type-obvious removable | 27 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 2261 |
| `binary-&&` | 2211 |
| `binary-\|\|` | 2034 |
| `optional-chain` | 2289 |
| `optional-declaration` | 3180 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 4217 |
| `truthy-left-review` | 28 |
| `type-obvious-removable` | 27 |
| `type-required-or-unknown` | 4523 |
| `upstream-type-review` | 3180 |

## Type-Obvious Removable Examples

- `packages/agent/src/actions/connector-resolver.ts:176:18` optional-chain: snapshot?.people
  - receiver type excludes null and undefined; type: `RelationshipsGraphSnapshot`
- `packages/agent/src/actions/connector-resolver.ts:220:44` binary-??: roomRecord.source ?? room.type
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/actions/connector-resolver.ts:354:28` binary-??: roomRecord.source ?? room.type
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/runtime/trajectory-internals.ts:328:36` optional-chain: action?.name?.trim
  - receiver type excludes null and undefined; type: `string`
- `packages/agent/src/runtime/trajectory-internals.ts:328:30` optional-chain: action?.name
  - receiver type excludes null and undefined; type: `Action`
- `packages/agent/src/actions/runtime.ts:151:38` optional-chain: runtime.actions?.length
  - receiver type excludes null and undefined; type: `Action[]`
- `packages/agent/src/actions/runtime.ts:152:42` optional-chain: runtime.providers?.length
  - receiver type excludes null and undefined; type: `Provider[]`
- `packages/agent/src/actions/runtime.ts:253:43` optional-chain: action.description?.trim
  - receiver type excludes null and undefined; type: `string`
- `packages/agent/src/api/apps-routes.ts:837:38` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:867:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:895:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:983:38` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1046:38` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1075:38` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1141:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1256:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1392:31` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1424:31` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/apps-routes.ts:1560:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/auth-routes.ts:127:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/api/database.ts:643:28` optional-chain: pgModule.default?.Pool
  - receiver type excludes null and undefined; type: `{ defaults: Defaults & ClientConfig; Client: typeof Client; ClientBase: typeof ClientBase; Events: typeof Events; Query: typeof Query; Pool: typeof Pool; ... 7 more ...; native: typeof import("/Users/shawwalters/milaidy/eliza/node_modules/.bun/@types+pg@8.20.0/node_modules/@types/pg/index") \| null; }`
- `packages/agent/src/api/permissions-routes.ts:250:30` optional-chain: shellState?.lastChecked
  - receiver type excludes null and undefined; type: `PermissionState`
- `packages/agent/src/runtime/prompt-optimization.ts:1328:38` optional-chain: runtime.actions?.map
  - receiver type excludes null and undefined; type: `Action[]`
- `packages/agent/src/api/inbox-routes.ts:586:25` binary-??: memory.entityId ?? memory.id
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/api/inbox-routes.ts:607:23` binary-??: memory.entityId ?? memory.id
  - left-hand type excludes null and undefined; type: `string`
- `packages/agent/src/api/inbox-routes.ts:2092:36` optional-chain: issue?.path?.join
  - receiver type excludes null and undefined; type: `PropertyKey[]`
- `packages/agent/src/runtime/eliza.ts:3263:39` binary-??: process.env.LOG_LEVEL ?? config.logging?.level
  - left-hand type excludes null and undefined; type: `string`
