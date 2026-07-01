# #10694 Background Evidence Refresh

Captured on July 1, 2026 from `docs/10694-background-evidence-refresh`
at `4078317282` (`origin/develop` at branch verification).

This evidence refresh covers the current unified background implementation:
the existing CSS `shader` color field, image background mode, undo/redo state
coverage, and settings-shell transparency. It does **not** close the remaining
#10694 feature scope for an arbitrary programmable WebGL/GLSL shader mode or
live Cerebras-driven `BACKGROUND` scenarios.

## Commands

```bash
bun run --cwd packages/ui test \
  src/state/useDisplayPreferences.background.test.tsx \
  src/state/persistence.background.test.ts \
  src/backgrounds/AppBackground.test.tsx \
  src/App.screen-background-fuzz.test.tsx \
  src/components/settings/AppearanceSettingsSection.background.test.tsx
```

Result: 5 files passed, 24 tests passed.

```bash
bun run --cwd plugins/plugin-app-control test src/actions/background.test.ts
```

Result: 1 file passed, 21 tests passed.

```bash
bun run --cwd packages/ui test:chat-ambient-e2e
```

Result: passed; wrote four ambient background screenshots.

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
E2E_RECORD=1 \
ELIZA_UI_SMOKE_SKIP_BUILD=1 \
ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1 \
ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 \
bun run --cwd packages/app test:e2e test/ui-smoke/settings-background.spec.ts
```

Result: 1 Chromium Playwright test passed in 47.6s. The test logged clean
shader and image diagnostics:

- `routedShellIsTransparent: true`
- `appBackgroundReachesTop: true`
- `backgroundKind: "shader"` and `"image"`
- `remainingOpaqueLayer: null`

Before using the skip-build path, I attempted the same app command without the
skip flags. It passed plugin/core/shared preflight but the cold
`packages/app build:web` Vite step made no filesystem progress after the build
output from `packages/app/dist` stopped changing, so I terminated that rerun
and used the documented prebuilt-renderer path above.

## Manual Review

- `desktop-shader.png` and `mobile-shader.png`: settings remain readable over
  the unified orange field; no obvious top safe-area seam or text overlap.
- `desktop-image.png` and `mobile-image.png`: busy fixture wallpaper remains
  intentionally noisy, but settings labels, controls, and composer remain
  usable; good stress coverage for transparency.
- `launcher-image-desktop.png` / `test-finished-1.png`: launcher/home shares
  the same busy wallpaper after the settings route, matching the unified
  background path.
- `settings-background-video.webm`: reviewed by extracting frames locally; it
  shows the shader-to-image settings flow and launcher reference.
- Ambient screenshots: current orange rim-pulse CSS field renders across
  animation phases and reduced-motion still state.

## Artifacts

- `desktop-shader.png`
- `mobile-shader.png`
- `desktop-image.png`
- `mobile-image.png`
- `launcher-image-desktop.png`
- `test-finished-1.png`
- `settings-background-video.webm`
- `settings-background-trace.zip`
- `ambient-01-phase-white-rim.png`
- `ambient-02-phase-mid.png`
- `ambient-03-phase-orange-rim.png`
- `ambient-04-reduced-motion-still.png`

## SHA-256

```text
5360b9017fe81d5ca1ff68bd0bda1c5c8f242466fdea7861f8c2265491fb11c1  ambient-01-phase-white-rim.png
ce28c7100b8dd3318c121f8165bf5f36e4b1b6c22a832569d25843d5fdfc69b8  ambient-02-phase-mid.png
5ed4e0b0e3105cac9ab6f7ddda14f7c5b806228728ed5a416de98b344e3a2c58  ambient-03-phase-orange-rim.png
4191ecda4f2268e6804ee3cc1dc19897c09dd83a2ce5c4a5ada4b683ecd05078  ambient-04-reduced-motion-still.png
373abf6bbd5518b1c1e1824521b33392bff74cd10829ee1888693e4107a5b634  desktop-image.png
a735ce183325189f0925834622ea246b7f63010cf176005767df6049c7ec64c7  desktop-shader.png
762dc6d0eb453fe4c67828b97fb6b266e97fbfa9f42d6e73fea47101a6645dd5  launcher-image-desktop.png
4e11bcc7fc9bacc927c60ca7c195e93c1dcaafc3d6c1d81805420171fbb3d053  mobile-image.png
db5c56d9ff0c22e2f5541b68b6f79b4b084ac37aaf88deda947945b592e3b3b4  mobile-shader.png
091cb751f330a6d6db522a93bcc6ba8adb79e5b3fda186f3b82722e93f6d6579  settings-background-trace.zip
29cdd575cf010eaaeece957402e4b21fa6563211a273f0ca8afc16b0e32bb386  settings-background-video.webm
762dc6d0eb453fe4c67828b97fb6b266e97fbfa9f42d6e73fea47101a6645dd5  test-finished-1.png
```

## Remaining Gaps

- Arbitrary programmable shader mode is still not implemented here.
- No live Cerebras / real-LLM scenario was run; no Cerebras/OpenAI provider
  credentials were present in this shell.
- Native iOS/Android/macOS captures were not rerun for this evidence refresh.
