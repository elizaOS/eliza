# #12903 browser/form/plugin-echo script normalization

Date: 2026-07-04
Base: `origin/develop` at `5dcd79eb2d`
Branch: `fix/12903-browser-form-echo-scripts`

## Scope

- `packages/examples/browser-extension`
- `packages/examples/browser-extension/chrome`
- `packages/examples/browser-extension/safari`
- `packages/examples/form`
- `packages/examples/plugin-echo`

This slice removes the fake browser-extension `typecheck` scripts, adds missing
read-only `lint:check` and format verbs, and makes Plugin Echo's `lint` mutating
while keeping `lint:check` read-only.

The documented browser-extension aggregate `build` skip remains in place because
the package documents target-specific build commands and the aggregate build is a
known browser-bundling constraint rather than a hidden `typecheck` alias.

## Validation

Commands run from a fresh sparse worktree based on current `origin/develop`:

```bash
git diff --check
```

Result: passed.

Inline Node audit over the edited `package.json` scripts.

Result for edited packages:

```text
packages/examples/browser-extension/package.json: ok
packages/examples/browser-extension/chrome/package.json: ok
packages/examples/browser-extension/safari/package.json: ok
packages/examples/form/package.json: ok
packages/examples/plugin-echo/package.json: ok
```

Package-local checks:

```bash
bun run --cwd packages/examples/browser-extension lint:check
bun run --cwd packages/examples/browser-extension format:check
bun run --cwd packages/examples/browser-extension/chrome lint:check
bun run --cwd packages/examples/browser-extension/chrome format:check
bun run --cwd packages/examples/browser-extension/safari lint:check
bun run --cwd packages/examples/browser-extension/safari format:check
bun run --cwd packages/examples/form lint:check
bun run --cwd packages/examples/form format:check
bun run --cwd packages/examples/plugin-echo lint:check
bun run --cwd packages/examples/plugin-echo format:check
```

Result: all passed.

Smoke/unit tests:

```bash
bun run --cwd packages/examples/browser-extension test
bun run --cwd packages/examples/plugin-echo test
```

Result:

- Browser extension: 6 passing Bun tests across root, Chrome, and Safari smoke tests.
- Plugin Echo: 1 passing Vitest file, 3 passing tests.

Additional delegated test attempted:

```bash
bun run --cwd packages/examples/form test
```

Result: blocked in the sparse worktree after entering `packages/examples/chat`
because dependencies for `dotenv/config` and `@elizaos/plugin-sql` were not
available in the sparse dependency graph. The Form scripts changed only by adding
check/format verbs; the delegated test command itself was not changed.

Residual scoped audit after this slice:

```text
packages=47 issues=36
```

Remaining failures are other example packages outside this PR's scope.
