# #10471 app-control VIEWS delete structured confirm evidence

## Change

- Removed raw `message.content.text` delete-target extraction from `VIEWS` delete.
- Replaced English confirmation/cancellation text matching with a structured `confirm` boolean parameter.
- Kept compatibility only for machine-like string booleans (`"true"`, `"1"`, `"false"`, `"0"`), not English prose such as `"yes"`.
- Added regression coverage proving English prose alone no longer supplies the target or confirms deletion.

## Validation

- `install-light.log` — `bun run install:light` completed in this worktree.
- `contracts-build.log` — built `@elizaos/contracts`, required for local package typecheck.
- `app-control-views-management-test.log` — focused VIEWS management tests passed (40 tests).
- `app-control-test.log` — full `plugins/plugin-app-control` test suite passed (33 files / 1256 tests).
- `app-control-typecheck.log` — `plugins/plugin-app-control` typecheck passed.
- `app-control-lint-check.log` — `plugins/plugin-app-control` lint check passed.
- `app-control-build.log` — `plugins/plugin-app-control` build passed after running with `~/.bun/bin` on `PATH` so package scripts can find `bunx`.
- `diff-check.log` — `git diff --check` passed.
- `root-verify.log` — older root `bun run verify` attempt after rebasing and refreshing dependencies. It passed the type-safety ratchet and reached Turbo lint/typecheck, then failed outside this slice on the then-existing `trajectory-viewer#lint` ambiguous-anchor findings in `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/src/components/LandingPage.tsx`. Treat the focused app-control logs above as the current evidence for this draft until root verify is refreshed.

## Evidence notes

- Live LLM trajectory: not captured in this environment because no supported model API key is present; see `model-key-presence.txt`.
- Screenshots / screen recording: N/A for this backend action contract change; no `packages/app` UI or view rendering code changed.
- Domain artifact: the relevant artifact is the persisted pending delete task plus uninstall request path, covered by `views-management.test.ts` assertions. No live dashboard/plugin uninstall flow was run in this environment.
