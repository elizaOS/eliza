# Issue #12904 - Script normalization packages

Date: 2026-07-04

Branch: `fix/12904-script-norm-packages`

Rebased on: `origin/develop` at `da8b55c8a37`

## Scope

- Normalized package scripts for the native/security/feed/peripheral package split from #12260.
- Extended `packages/scripts/audit-scripts.mjs` so the contract is enforced for the touched package set:
  required `test`, `lint`, `lint:check`, `format`, `format:check`; `typecheck` for TypeScript packages; `clean` iff `build`; mutating/read-only script separation; fake-success script rejection.
- Replaced placeholder script behavior with real package gates and fixed compile/lint/test issues exposed by those gates.
- Added missing TypeScript and test wiring for browser extension, Feed, OS, security/SOC2, native iOS deps, and related package lanes.

## Verification

Commands run from `/private/tmp/eliza-12904-script-norm-packages` unless noted.

- `bun install --no-save --ignore-scripts --cache-dir "$HOME/.bun-install-cache-deploy"` - passed.
- `node packages/scripts/audit-scripts.mjs --json` - passed with `{ "ok": true, "failures": [] }`.
- Changed-package `lint:check` sweep after rebase - passed, `Lint packages run: 37/37`.
- Changed-package `format:check` sweep after rebase - passed, `Format packages run: 37/37`.
- Changed-package `typecheck` sweep after rebase - passed, `Typecheck packages run: 30/30 in 127s`.
- Changed-package `test` sweep after rebase - passed, `Test packages run: 37/37 in 222s`.
- `bun run --cwd packages/feed test` - passed before rebase, `391 files passed, 0 files failed`; the post-rebase changed-package test sweep includes this package and passed.
- `bun run --cwd packages/feed/packages/testing test` - passed, `176 files passed, 0 files failed`.
- `bun run --cwd packages/os/android/system-ui test && bun run --cwd packages/security/soc2-verify test && bun run --cwd packages/os test` - passed; OS test lane reported `79 pass`, `12 skip`, `0 fail`.

## Root Verify

- `bun run verify` after rebase - failed outside this issue scope in `@elizaos/tui#lint`.
- Failure signature: existing lint diagnostics in `packages/tui/src/keys.ts` and `packages/tui/src/terminal.ts`, including forbidden non-null assertions and `noControlCharactersInRegex` diagnostics for terminal escape-sequence regexes.
- The root lint command runs in write mode and rewrote unrelated files under `packages/app`, `packages/core`, `packages/ui`, `plugins/plugin-native-llama`, `plugins/plugin-sql`, and `plugins/plugin-workflow`; those accidental verify outputs were reverted from this branch.

## Manual Review

- Reviewed the modified package scripts for mutating vs read-only separation.
- Reviewed the added audit checks against #12904/#12260 requirements.
- Reviewed the Feed root `test` change: default test now runs the real isolated unit lane; DB/server integration lanes remain explicit as `test:integration`, `test:integration:all`, and `test:ci`.
- Reviewed the Feed package testing `test:unit` change: it uses the isolated runner so Bun `mock.module()` state does not leak between unit files.
- Reviewed the Feed MCP typecheck fix: API/A2A declarations resolve through `dist` declarations so MCP typechecking does not pull sibling package source into its `rootDir`.
- Reviewed the root verify failure and confirmed it is outside the #12904 touched package set.

## Evidence Matrix

- UI screenshots/video: N/A - script/package normalization only; no user-facing UI surface changed.
- Frontend console/network logs: N/A - no browser workflow changed.
- Real LLM trajectories: N/A - no agent prompt/action/model behavior changed.
- Backend logs: N/A - no server runtime path changed.
- Domain artifacts: N/A - package manifests, tests, and audit output are the domain artifacts for this issue.
