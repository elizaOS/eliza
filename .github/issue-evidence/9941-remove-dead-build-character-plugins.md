# Issue 9941 Evidence: Remove Dead Core Plugin Map

Date: 2026-06-29

## Scope

This chunk addresses the first high-confidence #9941 item:

- Deleted dead `buildCharacterPlugins()` from `packages/core/src/character.ts`.
- Removed the divergent env-var to `@elizaos/plugin-*` map from the innermost `@elizaos/core` layer.

No runtime behavior should change: the function had no live source callers and was not exported from the core barrels.

## Local Verification

Passed:

```text
rg -n "buildCharacterPlugins" packages plugins scripts -g "*.ts" -g "*.tsx" -g "*.mjs" -g "*.cjs" -g "*.js" --glob "!**/dist/**" --glob "!**/node_modules/**"
no matches
```

```text
bunx @biomejs/biome check packages/core/src/character.ts
Checked 1 file in 577ms. No fixes applied.
```

```text
git diff --check
```

Attempted but blocked by the Windows worktree dependency state:

```text
bun run verify
[type-safety-ratchet] scanned 9862 tracked production source files
[type-safety-ratchet] as unknown as: 82 / 82
Error: spawn ...\node_modules\.bin\turbo ENOENT
```

```text
node node_modules\@typescript\native-preview\bin\tsgo --noEmit -p packages\core\tsconfig.json --pretty false
```

The command fails before reaching this change because the local install is incomplete: missing packages such as `fs-extra`, `mammoth`, `unpdf`, `dedent`, `file-type`, `handlebars`, `dotenv`, `json5`, and generated `validation-keyword-data` modules, plus a broken `drizzle-orm` type surface. No diagnostic referenced `packages/core/src/character.ts`.

## Evidence N/A

- Backend logs: N/A for dead-code deletion.
- Real-LLM trajectory: N/A, no model behavior changed.
- Screenshots/video/audio: N/A, no UI or voice surface changed.
