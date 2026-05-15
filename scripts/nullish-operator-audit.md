# Nullish Operator Audit Report

Generated: 2026-05-15T11:12:06.438Z

## Summary

| Metric | Count |
| --- | ---: |
| TypeScript files scanned | 612 |
| Operators found | 17319 |
| Type-obvious removable | 8 |
| Applied edits | 0 |

## By Kind

| Kind | Count |
| --- | ---: |
| `binary-??` | 2353 |
| `binary-&&` | 2618 |
| `binary-\|\|` | 2528 |
| `definite-assignment-assertion` | 23 |
| `optional-chain` | 2054 |
| `optional-declaration` | 7743 |

## By Classification

| Classification | Count |
| --- | ---: |
| `review-required` | 5081 |
| `truthy-left-review` | 88 |
| `type-obvious-removable` | 8 |
| `type-required-or-unknown` | 4399 |
| `upstream-type-review` | 7743 |

## Type-Obvious Removable Examples

- `packages/core/src/runtime/planner-loop.ts:1815:66` binary-??: record.name ?? record.toolName ?? record.tool ?? record.action ?? functionName
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1815:49` binary-??: record.name ?? record.toolName ?? record.tool ?? record.action
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1815:34` binary-??: record.name ?? record.toolName ?? record.tool
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1815:15` binary-??: record.name ?? record.toolName
  - left-hand type excludes null and undefined; type: `string`
- `packages/core/src/runtime/planner-loop.ts:1827:23` binary-??: record.input ?? record.args ?? record.arguments ?? record.params ?? record.parameters ?? rawFunction?.input ?? rawFunction?.arguments
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/runtime/planner-loop.ts:1826:22` binary-??: record.input ?? record.args ?? record.arguments ?? record.params ?? record.parameters ?? rawFunction?.input
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/runtime/planner-loop.ts:1825:18` binary-??: record.input ?? record.args ?? record.arguments ?? record.params ?? record.parameters
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
- `packages/core/src/runtime/planner-loop.ts:1824:21` binary-??: record.input ?? record.args ?? record.arguments ?? record.params
  - left-hand type excludes null and undefined; type: `string \| Record<string, JsonValue>`
