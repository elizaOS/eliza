# Issue #8876 - walkthrough evidence capture unblock

## Change under review

The shared ui-smoke API stub now answers optional custom-avatar probes at
`GET|HEAD /api/avatar/vrm` with `404 Not Found` instead of falling through to the
catch-all `501 Unhandled UI smoke API route`.

That mirrors the app's expected "no custom VRM configured" fallback and prevents
the full-walkthrough diagnostics gate from failing on an optional avatar asset
while still catching real 5xx API gaps.

## Verification run

- `bunx biome check packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs packages/app/test/ui-smoke/walkthrough/journey.ts` - pass.
- `git diff --check` - pass.
- Direct smoke-stub probe:
  - `HEAD http://127.0.0.1:39676/api/avatar/vrm` returned `404` with no body.
  - `GET http://127.0.0.1:39676/api/avatar/vrm` returned `404` with no body.
- Full walkthrough:
  - Command: `/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node packages/app/scripts/walkthrough-e2e.mjs --viewports desktop,mobile --skip-review`
  - Run id: `2026-07-01_18-50-18_mock`
  - Result: `2 passed (4.8m)`
  - Desktop gate: `ok: true`, 25 steps, `0` gated page/console errors, `0` server errors.
  - Mobile gate: `ok: true`, 25 steps, `0` gated page/console errors, `0` server errors.
  - Stitched videos: 65s desktop MP4 and 65s mobile MP4.
- iOS simulator capture:
  - Built from this tree first with `bun run --cwd packages/app build:ios:local:sim`.
  - Installed and launched `ai.elizaos.app` on booted iPhone 16 simulator.
  - Captured with `node packages/app/scripts/capture-ios-sim.mjs --issue 8876 --slug walkthrough-ios-sim-fresh-install --duration 10`.
- Real-LLM attachment smoke:
  - Command: `bun run --cwd packages/scenario-runner test:real-llm:attachment` after loading `.env` and `.env.local`.
  - Result: skipped cleanly, `no provider key in env (OPENAI/XAI/ANTHROPIC)`.
- Android device capture:
  - `adb devices` returned no attached device or emulator, so Android native capture is N/A on this host.

## Manual review

Reviewed `contact-sheet-desktop.png` and `contact-sheet-mobile.png` by eye.
The walkthrough captures are nonblank and include cold launch, onboarding,
settings, wallet, chat, large-paste attachment, launcher, chat-over-view,
settings edit, and dashboard-rest states.

Reviewed representative frames:

- `desktop-16-paste-large.png`: desktop chat sheet shows the large paste as a
  `pasted-text.md` attachment chip.
- `mobile-16-paste-large.png`: mobile chat sheet shows the `pasted-text.md`
  attachment chip and preserved conversation bubbles.
- `mobile-24-settings-edit.png`: mobile settings capabilities view is readable
  with no heading/back-button overlap.

Reviewed `8876-walkthrough-ios-sim-fresh-install-ios-sim.png`: the freshly
built app launches on the iOS simulator and renders the app shell/chat surface.

## Artifacts

- `walkthrough-desktop.mp4`
- `walkthrough-mobile.mp4`
- `contact-sheet-desktop.png`
- `contact-sheet-mobile.png`
- `desktop-16-paste-large.png`
- `mobile-16-paste-large.png`
- `mobile-24-settings-edit.png`
- `desktop-steps.json`
- `mobile-steps.json`
- `../8876-walkthrough-ios-sim-fresh-install-ios-sim.png`
- `../8876-walkthrough-ios-sim-fresh-install-ios-sim.mov`
