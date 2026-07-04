# Issue #12904: peripheral non-Feed package script normalization

## Scope

First #12904 slice covering non-Feed packages:

- `packages/browser-extension`
- `packages/docs`
- `packages/homepage`
- `packages/native/bun-runtime`
- `packages/native/ios-deps`
- `packages/os/android/system-ui`
- `packages/os/shared-system`
- `packages/os/homepage`
- `packages/os/setup`
- `packages/os/usb-installer`
- `packages/security`
- `packages/security/soc2-verify`
- `packages/vault`
- `packages/import-conversations`

Feed nested packages are intentionally left for a separate #12904 slice because
`packages/feed` is a nested monorepo with its own generated guide workflow.

## Changes

- Added standard mutating `lint`, read-only `lint:check`, mutating `format`,
  and read-only `format:check` scripts where missing.
- Added `clean` scripts for packages with build outputs.
- Split OS installer build scripts so `typecheck` owns no-emit TypeScript checks
  and `build` only emits Vite artifacts.
- Added real `typecheck` for `@elizaos/os-shared-system`.
- Removed unsupported/redundant ARIA attributes and non-null assertions in
  `@elizaos/os-android-system-ui` so its new `lint:check` passes.
- Updated package-local `CLAUDE.md` / `AGENTS.md` command lists for touched
  packages that document scripts, and verified each pair remains identical.

## Verification

Passed:

```bash
node <focused #12904 non-Feed script audit>
# packages=16 issues=0

git diff --check

for p in packages/browser-extension packages/docs packages/native/bun-runtime packages/native/ios-deps packages/os/android/system-ui packages/os/shared-system packages/os/homepage packages/os/setup packages/os/usb-installer packages/security packages/security/soc2-verify packages/vault packages/import-conversations packages/homepage; do bun run --cwd "$p" lint:check; done

for p in packages/browser-extension packages/docs packages/native/bun-runtime packages/native/ios-deps packages/os/android/system-ui packages/os/shared-system packages/os/homepage packages/os/setup packages/os/usb-installer packages/security packages/security/soc2-verify packages/vault packages/import-conversations packages/homepage; do bun run --cwd "$p" format:check; done

bun run --cwd packages/docs test
bun run --cwd packages/native/bun-runtime test
bun run --cwd packages/browser-extension test:smoke
bun run --cwd packages/browser-extension clean
bun run --cwd packages/os/shared-system typecheck
bun run --cwd packages/import-conversations typecheck
bun run --cwd packages/os/homepage clean
bun run --cwd packages/homepage clean

for d in packages/browser-extension packages/docs packages/os packages/os/homepage packages/security packages/security/soc2-verify packages/vault packages/homepage; do cmp -s "$d/CLAUDE.md" "$d/AGENTS.md" || exit 1; done
```

Notes:

- `packages/security lint:check` and `packages/security/soc2-verify lint:check`
  exit successfully while reporting existing Biome warnings for no-non-null and
  assignment-in-expression diagnostics.
- `packages/browser-extension test:smoke` required adding
  `plugins/plugin-wallet` to the sparse checkout because the extension build
  reads `plugins/plugin-wallet/src/browser-shim/shim.template.js`. No plugin
  files were edited.

Blocked by the temp worktree's incomplete dependency install:

```bash
bun run --cwd packages/os/android/system-ui test
# vitest: command not found

bun run --cwd packages/browser-extension test:unit
# Cannot resolve vitest/config

bun run --cwd packages/os/android/system-ui typecheck
# Cannot resolve vitest types

bun run --cwd packages/os/setup typecheck
bun run --cwd packages/os/usb-installer typecheck
# Cannot resolve bun/node type packages

bun run --cwd packages/security typecheck
bun run --cwd packages/security/soc2-verify typecheck
bun run --cwd packages/vault typecheck
# Cannot resolve node/vitest type packages

bun run --cwd packages/import-conversations test
# Cannot find node_modules/vitest/vitest.mjs
```

Evidence matrix:

- Screenshots/video: N/A - script normalization plus non-visual System UI lint
  cleanup only; no `packages/app` UI surface changed.
- Frontend console/network logs: N/A - no browser flow changed.
- Backend logs: N/A - package scripts and lint-only source cleanup.
- Real-LLM trajectories: N/A - no agent/action/prompt/model behavior changed.
