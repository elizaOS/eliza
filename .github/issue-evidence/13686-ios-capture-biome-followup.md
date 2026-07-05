# #13686 iOS Capture Biome Follow-up

Date: 2026-07-05
Branch: `fix/13686-ios-device-capture-biome`

## Scope

Agent verification of #13686 on current `develop` found the deterministic shard
tests passing, but the documented Biome command failed on
`packages/app/scripts/ios-device-capture.mjs` for import ordering/formatting.
This follow-up contains only Biome's safe formatting fix for that script.

## Verification

Passed:

```bash
bun install
# no install errors
```

```bash
node packages/shared/scripts/generate-keywords.mjs --target ts
# Done
```

```bash
bun test packages/app/scripts/ios-device-lib.test.mjs
# 91 pass, 0 fail
```

```bash
bunx @biomejs/biome check packages/app/scripts/ios-device-lib.test.mjs packages/app/scripts/ios-device-capture.mjs packages/app/scripts/ios-device-lib.mjs
# Checked 3 files. No fixes applied.
```

```bash
node --check packages/app/scripts/ios-device-lib.mjs
node --check packages/app/scripts/ios-device-lib.test.mjs
git diff --check
# passed
```

Blocked local live capture:

```bash
xcodebuild -version
# xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance

xcrun --find simctl
# xcrun: error: unable to find utility "simctl", not a developer tool or in PATH

bun run --cwd packages/app capture:ios-sim:boot
# ERROR: iOS workspace missing at packages/app/ios/App. Run a mobile build first.
```

## Result

The deterministic #13686 shard planner/reset proof is green after this follow-up
format fix. The remaining real simulator proof still requires a macOS host with
full Xcode selected and a generated iOS project.
