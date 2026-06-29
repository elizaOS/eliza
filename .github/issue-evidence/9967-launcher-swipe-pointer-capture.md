# Issue 9967 Evidence: Launcher Touch Swipe Pointer Capture

Date: 2026-06-29

## Scope

This PR addresses one device-reported launcher failure from #9967: on Android
WebView, a touch swipe from the home page to the apps page can be cancelled when
the horizontal pager calls `setPointerCapture()` on the live touch pointer.

The code change is limited to `packages/ui/src/hooks/useHorizontalPager.ts`:

- touch pointers rely on the browser's implicit pointer capture;
- mouse and pen pointers still call `setPointerCapture()` explicitly;
- `packages/ui/src/components/pages/Launcher.gestures.test.tsx` simulates the
  Android WebView `pointercancel` quirk and verifies the touch swipe commits.

## Local Verification On Windows

Passed:

```text
bunx @biomejs/biome check packages/ui/src/hooks/useHorizontalPager.ts packages/ui/src/components/pages/Launcher.gestures.test.tsx
Checked 2 files. No fixes applied.
```

```text
git diff --check origin/develop...HEAD
```

```text
bunx vitest run --config vitest.config.ts src/components/pages/Launcher.gestures.test.tsx
Test Files  1 passed (1)
Tests       9 passed (9)
```

The focused test initially could not import because this Windows worktree had
an incomplete dependency store. Before the successful run, the local environment
was repaired with package links for generated core i18n data, `@elizaos/registry`,
`drizzle-orm`, and `get-east-asian-width`. Those repairs were local
`node_modules`/generated-file setup only; no tracked source files were changed.

## Device Evidence

The PR body records the on-device diagnosis from a Pixel 9a:

```text
pointerdown -> pointermove -> pointercancel -> lostpointercapture
```

It also records that the APK was rebuilt and reinstalled after the fix. That
device was not attached to this Windows review session, so this file records the
unit regression proof from this machine and leaves real-device rerun/recording
to the device holder.

## Evidence N/A

- Real-LLM trajectory: N/A, no model behavior changed.
- Backend logs: N/A, client gesture handler only.
- Audio: N/A, no voice/audio behavior changed.
- Screenshots/video from this Windows box: N/A for the Android WebView
  cancellation itself; the regression is covered by the simulated
  `pointercancel` unit test above.
