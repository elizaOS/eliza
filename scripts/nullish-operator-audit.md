# Nullish Operator Audit Report

Generated: 2026-05-15T10:48:12.260Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 612 |
| Operators found | 17323 |
| Type-obvious removable | 12 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 2356 |
| `binary-&&` | 2618 |
| `binary-\|\|` | 2528 |
| `definite-assignment-assertion` | 23 |
| `optional-chain` | 2055 |
| `optional-declaration` | 7743 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 5081 |
| `truthy-left-review` | 88 |
| `type-obvious-removable` | 12 |
| `type-required-or-unknown` | 4399 |
| `upstream-type-review` | 7743 |

## Type-Obvious Removable Examples

- `packages/core/src/runtime/planner-loop.ts:1818:18` binary-??: record.name ?? record.toolName ?? record.tool ?? record.action ?? record.actionName
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1817:16` binary-??: record.name ?? record.toolName ?? record.tool ?? record.action
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1816:20` binary-??: record.name ?? record.toolName ?? record.tool
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1815:15` binary-??: record.name ?? record.toolName
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1831:23` binary-??: record.input ?? record.args ?? record.arguments ?? record.params ?? record.parameters ?? rawFunction?.input ?? rawFunction?.args
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/runtime/planner-loop.ts:1830:22` binary-??: record.input ?? record.args ?? record.arguments ?? record.params ?? record.parameters ?? rawFunction?.input
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/runtime/planner-loop.ts:1829:18` binary-??: record.input ?? record.args ?? record.arguments ?? record.params ?? record.parameters
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/runtime/planner-loop.ts:1828:21` binary-??: record.input ?? record.args ?? record.arguments ?? record.params
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/services/message.ts:2629:15` binary-??: entry.name ?? entry.toolName
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/services/message.ts:4468:15` binary-??: entry.name ?? entry.toolName
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime.ts:4524:56` binary-??: resolvedModel?.provider ?? provider
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime.ts:4524:45` optional-chain: resolvedModel?.provider
  - receiver type excludes null and undefined; type: `{ handler: (runtime: IAgentRuntime, params: Record<string, object \| JsonValue>) => Promise<object \| JsonValue>; modelKey: string; provider: string; }`
