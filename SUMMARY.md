# Reasoning-tag residue fix

## Findings

The planner's local `stripReasoningArtifacts` recognized only `think`, while the shared outbound sanitizer already defined the full machine-syntax family list. The shared implementation still did not accept whitespace after `<` or around `/`, and did not recover close-only output. The evaluator's `thinking: "off"` provider option was only a hint; its parsed `messageToUser` had no reasoning-tag cleanup of its own.

## Changes

- Made `stripReasoningArtifacts` delegate to `sanitizeOutboundText`, eliminating a second, incomplete tag list while retaining the planner-specific cleanup boundary.
- Extended the shared sanitizer to recognize mixed-case and whitespace variants for `think`, `thinking`, `reasoning`, `reflection`, `thought`, `antthinking`, `tool_call`, and `function_call`.
- Preserved existing open-only removal and code-fence/inline-code protection.
- Added close-only recovery for all machine-syntax families, keeping only content after the last orphan close.
- Sanitized evaluator `messageToUser` output even when the model call requests `thinking: "off"`.
- Added a parameterized `bun:test` suite and a dependency-free Node verification harness.

## Verification

Run:

```sh
node verify-reasoning-tags.mjs
bun test reasoning-tag-residue.test.ts
```

The Node harness exercises all requested cases without repository dependencies. The Bun test requires Bun to be present in the full repository environment.

## Local result

`node verify-reasoning-tags.mjs` passed all eight tag families and both planner/evaluator integration assertions. Bun and TypeScript CLI tooling are not installed in the cleanroom, so the `bun:test` suite could not be executed here; it remains ready for the full repository environment.
