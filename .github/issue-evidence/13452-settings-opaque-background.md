# #13452 Settings opaque background slice

## Scope

Changed the builtin tab background policy so Settings no longer opts into the
shared launcher wallpaper. This is a narrow slice of #13452 that prevents the
documented Settings view leak while leaving the broader view-isolation manifest
work open.

## Local verification

Command:

```bash
bunx @biomejs/biome check --write packages/ui/src/builtin-tab-registry.ts packages/ui/src/builtin-tab-registry.test.ts packages/ui/src/App.screen-background-fuzz.test.tsx
```

Result: passed; Biome formatted the touched files.

Command:

```bash
bunx @biomejs/biome check packages/ui/src/builtin-tab-registry.ts packages/ui/src/builtin-tab-registry.test.ts packages/ui/src/App.screen-background-fuzz.test.tsx
```

Result: passed.

Command:

```bash
bun -e 'import { resolveBuiltinBackgroundPolicy } from "./packages/ui/src/builtin-tab-registry.ts"; console.log(JSON.stringify({ chat: resolveBuiltinBackgroundPolicy("chat", "/chat"), settings: resolveBuiltinBackgroundPolicy("settings", "/settings"), views: resolveBuiltinBackgroundPolicy("views", "/views") }));'
```

Result:

```json
{"chat":"shared","settings":null,"views":"shared"}
```

## Blocked verification

Command:

```bash
bun run --cwd packages/ui test src/builtin-tab-registry.test.ts src/App.screen-background-fuzz.test.tsx
```

Result: blocked before test execution because the temp worktree dependency tree
cannot resolve `react/package.json` while loading `packages/ui/vitest.config.ts`.

The local host also only has CommandLineTools selected and lacks an available
iOS simulator SDK, so iOS simulator screenshots, screen recording, and
installed-app capture could not be produced locally for this slice.

## Evidence not applicable for this slice

Real-LLM trajectories: N/A - this changes shell background routing only; no
agent/action/provider/prompt/model behavior changed.

Backend logs: N/A - no backend code path changed.

Domain artifacts: N/A - no persisted memories, scheduled tasks, database rows,
files, or on-chain/device artifacts are produced by this background policy
change.
