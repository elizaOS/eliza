# #12903 tooling/test format script evidence

Branch slice: add missing format verbs for the non-example tooling/test
packages still in #12903 scope.

## Packages

- `packages/scenario-runner`
- `packages/skills`
- `packages/test`
- `packages/test/cloud-e2e`
- `packages/test/cloud-mocks`

## Script contract changes

- Added `format` and read-only `format:check`.
- Kept existing build, clean, lint, test, typecheck, and E2E scripts unchanged.
- Did not add artifact-free `build` scripts.
- Scoped `scenario-runner` and `cloud-e2e` format commands to `package.json`
  because full-package Biome format currently reports pre-existing test-file
  formatting drift outside this package-metadata-only change.

## Verification

Current working tree: `origin/develop` at `222307ddb8`.

Diff hygiene:

```bash
git diff --check
```

Result: passed.

Static script guard:

```bash
node --input-type=module <<'NODE'
// Parses the five edited package.json files, rejects fake/masked scripts,
// requires format + format:check, requires lint:check when lint exists, and
// rejects build scripts that only run typecheck.
NODE
```

Result:

```text
packages/scenario-runner/package.json: ok
packages/skills/package.json: ok
packages/test/package.json: ok
packages/test/cloud-e2e/package.json: ok
packages/test/cloud-mocks/package.json: ok
tooling/test slice issues=0
```

Read-only format checks:

```bash
bun run --cwd packages/scenario-runner format:check
bun run --cwd packages/skills format:check
bun run --cwd packages/test format:check
bun run --cwd packages/test/cloud-e2e format:check
bun run --cwd packages/test/cloud-mocks format:check
```

Result:

```text
packages/scenario-runner: passed, 1 file checked.
packages/skills: passed, 7 files checked.
packages/test: passed, 78 files checked.
packages/test/cloud-e2e: passed, 1 file checked.
packages/test/cloud-mocks: passed, 18 files checked.
```

Focused tests:

```bash
bun run --cwd packages/test/cloud-mocks test
```

Result:

```text
packages/test/cloud-mocks: passed, 46 tests.
```

## Sparse-worktree blockers

The following probes were attempted in this sparse auxiliary worktree and are
blocked by missing workspace/dependency surfaces or existing config gates:

```text
packages/skills test: 26 tests passed; frontmatter/provenance tests fail because
  this sparse worktree cannot resolve package "yaml".

packages/test test: fails at import/config time. Blockers include missing
  packages/app-core/test/eliza-package-paths.ts, unresolved plugin packages
  (@elizaos/plugin-discord, @elizaos/plugin-anthropic, @elizaos/plugin-slack,
  @elizaos/plugin-telegram), and invalid RegExp flag "v" in this linked test
  dependency/runtime combination.

packages/scenario-runner test: 17 files passed and 113 tests passed; failures
  are from sparse checkout omissions (missing workflows/app/ui/plugin files and
  plugin packages), plus the same RegExp flag "v" resolver issue.

packages/test/cloud-e2e typecheck: TypeScript reports TS5101 because
  compilerOptions.baseUrl is deprecated under TypeScript 6 unless
  ignoreDeprecations is set.
```

Full `bun install` / root `bun run verify` were not run in this auxiliary
worktree; it reuses an external `node_modules` symlink and avoids mutating the
main checkout.
