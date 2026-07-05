# #13571 iOS Boot Gate Regression Tests

Follow-up after #14200. That PR fixed the Xcode 26 simulator boot-gate
breakage, but its post-merge review noted two harness fixes were not pinned by
focused regression tests:

- `simctl listapps <udid>` plist/bundle-presence proof
- `--strict-gate` bypass of the full XCUITest coverage guard

This change extracts those decisions into pure helpers and covers them in
`packages/app/scripts/ios-device-lib.test.mjs`.

## Checks

```bash
bun run --cwd packages/app test -- scripts/ios-device-lib.test.mjs
```

Result: pass, 1 file / 97 tests.

```bash
bunx biome check \
  packages/app/scripts/ios-device-lib.mjs \
  packages/app/scripts/ios-device-lib.test.mjs \
  packages/app/scripts/ios-device-capture.mjs
```

Result: pass.

```bash
node --check packages/app/scripts/ios-device-lib.mjs
node --check packages/app/scripts/ios-device-capture.mjs
git diff --check
```

Result: pass.

## Remaining Evidence

This does not provide the missing real simulator screenshot/video/xcresult
artifacts from #14200. Those still require a macOS/Xcode simulator host with the
app built and installed. This patch only closes the code-level regression-test
residual called out after #14200 merged.
