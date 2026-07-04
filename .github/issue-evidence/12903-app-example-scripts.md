# #12903 app example script normalization

Date: 2026-07-04
Base: `origin/develop` at `6ada4e6185`
Branch: `fix/12903-app-example-scripts`

## Scope

- `packages/examples/app/capacitor/backend`
- `packages/examples/app/capacitor/frontend`
- `packages/examples/app/electron/backend`
- `packages/examples/app/electron/frontend`

This final examples slice removes empty backend test passes, replaces the
Capacitor backend's `build: bun run typecheck` alias with a real Bun build, adds
backend smoke tests, and adds missing `lint:check`, `format`, and read-only
`format:check` scripts to the app subpackages.

No app UI source was changed.

## Validation

Commands run from a fresh sparse worktree based on current `origin/develop`:

```bash
git diff --check
```

Result: passed.

Inline script-contract audit over the edited package manifests:

```text
packages/examples/app/capacitor/backend/package.json: ok
packages/examples/app/capacitor/frontend/package.json: ok
packages/examples/app/electron/backend/package.json: ok
packages/examples/app/electron/frontend/package.json: ok
```

Package-local checks and tests:

```bash
bun run --cwd packages/examples/app/capacitor/backend lint:check
bun run --cwd packages/examples/app/capacitor/backend format:check
bun run --cwd packages/examples/app/capacitor/backend test
bun run --cwd packages/examples/app/capacitor/frontend lint:check
bun run --cwd packages/examples/app/capacitor/frontend format:check
bun run --cwd packages/examples/app/capacitor/frontend test
bun run --cwd packages/examples/app/electron/backend lint:check
bun run --cwd packages/examples/app/electron/backend format:check
bun run --cwd packages/examples/app/electron/backend test
bun run --cwd packages/examples/app/electron/frontend lint:check
bun run --cwd packages/examples/app/electron/frontend format:check
bun run --cwd packages/examples/app/electron/frontend test
```

Result: all passed.

Build check:

```bash
bun run --cwd packages/examples/app/capacitor/backend build
```

Result: passed; Bun bundled `src/server.ts` and emitted `server.js`.

Parent workspace smoke tests:

```bash
bun run --cwd packages/examples/app/capacitor test
bun run --cwd packages/examples/app/electron test
```

Result:

- Capacitor app workspace: 6 passing Bun tests across parent, backend, and frontend smoke files.
- Electron app workspace: 6 passing Bun tests across parent, backend, and frontend smoke files.

Full examples audit after this slice:

```text
packages=47 issues=0
```

Full #12903 scoped audit after this slice:

```text
packages=68 issues=0
```
