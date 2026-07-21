# TypeScript compiler model

Eliza uses separate TypeScript packages for different jobs:

- `@typescript/native` aliases `typescript@^7.0.2` and provides the stable native `tsc` checker used by workspace `typecheck` scripts.
- `@typescript/typescript6@^6.0.2` provides the `tsc6` compatibility binary used by declaration emit.
- `typescript@^6.0.3` remains available to AST tooling, ecosystem declaration plugins, and runtime transpilation fallbacks until the TypeScript 7 compiler API is ready.

Do not use a globally installed compiler. Run checks through package scripts, for example:

```sh
bun run --cwd packages/core typecheck
bun run typecheck
```

Run `bun x tsc --version` to verify that command-line checks resolve TypeScript 7. Editors that support the native TypeScript extension should use the project-local `@typescript/native` installation. Editors that still require the JavaScript compiler API may continue to use workspace TypeScript 6 during this transition.

## Compiler API consumers

TypeScript 7 does not yet expose the complete compiler API used by repository tooling. Existing code that parses or transforms source continues to import the project-pinned TypeScript 6 implementation:

```ts
import ts from "typescript";
```

Do not move compiler API consumers to `@typescript/native` until that API is supported. The `@typescript/typescript6` package is reserved for the explicit `tsc6` compatibility binary.

## Declaration emit

Declaration workflows remain on `tsc6` to avoid changing published `.d.ts` output during the checker migration. Use `--noCheck` when a stable TypeScript 7 typecheck already covers the same source.

## Rollback

If a TypeScript 7 checker regression blocks CI:

1. Revert the migration commit so scripts return to `tsgo` and the lockfile restores `@typescript/native-preview`.
2. Run `bun install --frozen-lockfile`.
3. Run the affected package typecheck and `bun run audit:build-model`.

Do not point native-check scripts at `tsc6` as an ad hoc rollback. Keeping checker selection in the lockfile and scripts makes local, CI, and editor behavior reproducible.
