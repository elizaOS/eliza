# Evidence: #12903 configbench script contract

## Scope

- `packages/benchmarks/configbench/package.json`

## Change

- Removed `build: bun run typecheck` because ConfigBench does not emit package-level build artifacts.
- Kept `typecheck` as the TypeScript validation command.
- Added `lint:check`, `format`, and `format:check` as explicit read-only/mutating check verbs.
- Added `check` to run the package-local typecheck, lint check, and format check together.

## Verification

Commands run from a full workspace checkout on 2026-07-04:

```bash
git diff --check github/develop...HEAD
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('packages/benchmarks/configbench/package.json', 'utf8'));
const scripts = pkg.scripts || {};
const failures = [];
if ('build' in scripts) failures.push('build script should be absent');
for (const key of ['typecheck', 'lint', 'lint:check', 'format', 'format:check', 'check', 'test']) {
  if (!scripts[key]) failures.push(`missing ${key}`);
}
for (const [name, value] of Object.entries(scripts)) {
  if (/echo\s+['"]?(No|no|Skipping|skip|nothing|No tests|No build|No lint|No typecheck)|exit 0|true\b|\|\| true/i.test(value)) {
    failures.push(`${name} masks success: ${value}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
NODE
bun run --cwd packages/benchmarks/configbench lint:check
bun run --cwd packages/benchmarks/configbench format:check
bun run --cwd packages/benchmarks/configbench typecheck
bun run --cwd plugins/plugin-groq build
bun run --cwd packages/benchmarks/configbench test
bun run --cwd packages/benchmarks/configbench check
```

`bun run --cwd packages/benchmarks/configbench test` initially failed before the
workspace dependency was prepared because Vite could not resolve
`@elizaos/plugin-groq`; after `bun run --cwd plugins/plugin-groq build`, the same
test command passed with 7 files and 26 tests.

## Evidence Matrix

- Real-LLM trajectories: N/A - package metadata script normalization only; no benchmark behavior, prompt, model, or handler path changed.
- Backend/frontend logs: N/A - no runtime server or UI behavior changed.
- Screenshots/video/audio: N/A - no user-facing UI or audio behavior changed.
- Domain artifacts: N/A - no benchmark run output is produced by the metadata change; package-local tests and checks exercise the changed script surface.
