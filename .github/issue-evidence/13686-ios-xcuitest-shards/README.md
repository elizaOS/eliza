# Issue #13686 — iOS XCUITest Fresh-Container Shards

## Change

- Default `ios-device-capture.mjs` full runs now expand `AppUITests` into deterministic per-test/per-class shards.
- Each shard resets the app container before `xcodebuild test-without-building`:
  - simulator: `simctl terminate`, `simctl uninstall`, then reinstall `.xctestrun` app bundles.
  - device: `devicectl device uninstall app`, then reinstall the signed app when `--app-path` is supplied.
- Shard artifacts land under `ios/build/boot-capture/<timestamp>/shards/<id>/`, with per-shard attachments, `.xcresult`, raw summary, and top-level aggregate `test-summary.json`.
- `GestureSemanticsUITests.testChatSheetDetentFlickCycle` now seeds a persistent user message and asserts the populated-thread flick branch instead of choosing assertions from inherited residue.

## Verification Run

```bash
bun install
bun run --cwd packages/app test scripts/ios-device-lib.test.mjs
bunx biome check packages/app/scripts/ios-device-capture.mjs packages/app/scripts/ios-device-lib.mjs packages/app/scripts/ios-device-lib.test.mjs packages/app/CLAUDE.md packages/app/AGENTS.md packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift
node --check packages/app/scripts/ios-device-capture.mjs
node --check packages/app/scripts/ios-device-lib.mjs
node --check packages/app/scripts/ios-device-lib.test.mjs
node packages/app/scripts/ios-device-capture.mjs --help
git diff --check -- packages/app/scripts/ios-device-capture.mjs packages/app/scripts/ios-device-lib.mjs packages/app/scripts/ios-device-lib.test.mjs packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift packages/app/CLAUDE.md packages/app/AGENTS.md
```

Results:

- Package Vitest: `1 passed (1)`, `74 passed (74)`.
- Post-rebase package Vitest: `1 passed (1)`, `74 passed (74)`; emitted a pre-existing duplicate root script-key warning for `test:desktop:packaged:windows`.
- Biome focused check: `Checked 3 files in 110ms. No fixes applied.`
- Node syntax checks: passed.
- Help output includes new `--bundle-id <id>` flag.
- Diff whitespace check: passed.

Broader package gate attempted:

```bash
bun run --cwd packages/app typecheck
```

Result: failed before this change's JS harness code, with missing workspace/generated modules (`@elizaos/app-core`, `@elizaos/contracts`, `@elizaos/cloud-routing`, validation keyword data, `@elizaos/tui`) and existing `AccountWithCredentialFlag` property errors in `packages/ui`. This run is not claimed as passing.

## Live iOS Capture

Attempted local Xcode preflight:

```bash
xcodebuild -version
```

Result:

```text
xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance
```

This host also has no generated `packages/app/ios/App` project in the clean worktree, so a real simulator/device XCUITest capture could not be run here. The code path is covered by the pure shard planner tests and syntax checks, but the first real verification run still needs a macOS host with full Xcode selected and a generated iOS project.

## Manual Review

Reviewed the changed code paths by hand:

- Default `AppUITests` no longer maps to one monolithic `-only-testing AppUITests` run.
- Both onboarding tests are separate shards, so cloud and local first-run paths start from clean containers.
- `DeviceLifecycleUITests` remains one class shard, preserving its intentional within-test persistence assertions.
- `--only-testing AppUITests/<Class>[/test]` remains a single-shard override for narrow/manual runs.
