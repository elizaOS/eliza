# Evidence: #12903 benchmark library script contract

## Scope

- `packages/benchmarks/framework/typescript/package.json`
- `packages/benchmarks/lib/package.json`

## Change

- Removed artifact-free `build: bun run typecheck` scripts from the benchmark
  framework package and shared benchmark library.
- Kept `typecheck` as the real TypeScript validation command.
- Added read-only `lint:check` and `format:check` verbs plus mutating
  `format`.
- Added package-local `check` scripts that run typecheck, lint check, and
  format check.
- Added the benchmark framework's missing workspace dependencies for the
  `@elizaos/*` packages it imports during typecheck.

## Verification

Commands run on 2026-07-04 from a worktree rebased on current
`origin/develop`:

```bash
git diff --check
node - <<'NODE'
const fs = require('fs');
for (const p of [
  'packages/benchmarks/framework/typescript/package.json',
  'packages/benchmarks/lib/package.json',
]) {
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const scripts = pkg.scripts || {};
  const failures = [];
  if ('build' in scripts) failures.push('build script should be absent');
  for (const key of ['typecheck', 'lint', 'lint:check', 'format', 'format:check', 'check']) {
    if (!scripts[key]) failures.push(`missing ${key}`);
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (/echo\s+|exit\s+0|\|\|\s*true/.test(String(value))) {
      failures.push(`${name} masks success: ${value}`);
    }
  }
  if (failures.length) {
    console.error(`${p}: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${p}: script contract ok`);
  }
}
NODE
bun run --cwd packages/benchmarks/framework/typescript check
bun run --cwd packages/benchmarks/lib check
bun run --cwd packages/benchmarks/lib test
```

Result:

```text
packages/benchmarks/framework/typescript/package.json: script contract ok
packages/benchmarks/lib/package.json: script contract ok
packages/benchmarks/framework/typescript check: passed after building @elizaos/plugin-openai and @elizaos/plugin-cli-inference
packages/benchmarks/framework/typescript lint:check: passed, 5 files
packages/benchmarks/framework/typescript format:check: passed, 5 files
packages/benchmarks/lib check: passed, 12 files lint/format checked
packages/benchmarks/lib test: passed, 4 files / 44 tests
```

`packages/benchmarks/framework/typescript check` initially needed the
`@elizaos/plugin-openai` and `@elizaos/plugin-cli-inference` workspace packages
prepared. After `bun run --cwd plugins/plugin-openai build` and
`bun run --cwd plugins/plugin-cli-inference build`, the package-local `check`
script passed.

## Evidence Matrix

- Real-LLM trajectories: N/A - package metadata script normalization only; no
  benchmark scenario, model, prompt, or handler path changed.
- Backend/frontend logs: N/A - no runtime server or UI behavior changed.
- Screenshots/video/audio: N/A - no user-facing UI or audio behavior changed.
- Domain artifacts: N/A - no benchmark result artifacts were produced by this
  metadata-only change; package-local checks and tests exercise the changed
  script surface.
