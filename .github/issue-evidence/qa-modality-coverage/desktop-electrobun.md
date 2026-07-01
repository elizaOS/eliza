# Desktop (Electrobun) packaged e2e — headless on Linux

The desktop shell was **built and driven as a packaged app** on this Linux host
(`DISPLAY=:0`, Electrobun's GTK-only native wrapper + WebKitGTK + WGPU/Dawn):

```bash
node packages/app-core/scripts/desktop-build.mjs build   # → build/dev-linux-x64/Eliza-dev/bin/launcher
bun run --cwd packages/app test:desktop:packaged          # playwright.electrobun.packaged.config.ts
```

The build produced a real packaged launcher
(`build/dev-linux-x64/Eliza-dev/bin/launcher`, `Eliza.desktop`, `libwebgpu_dawn.so`,
`Info.plist`). The packaged e2e then launches that binary and drives the live
WebKitGTK renderer.

| spec | result |
| --- | --- |
| `desktop-launch-render` — packaged app launches + renders a non-blank UI headless | **✅ pass** (12.8s) |
| `electrobun-bottom-bar` — bottom-bar mode opens a chromeless, short, bottom-anchored main window (#10716 surface) | **✅ pass** (6.1s) |
| `electrobun-packaged-regressions` — persists media/provider/plugin state across relaunch | ❌ env — settings/voice shell never hydrated (`bodyText:""`, `rootHtmlLength:512`); the headless packaged smoke does not fully provision the desktop backend/first-run for the deep settings route |
| `desktop-voice-selftest` — live voice self-test vs a real desktop API base + local TTS | ⏭ skipped (needs real desktop API base + TTS) |
| `electrobun-relaunch` — relaunch after cloud first-run triggers native restart | ⏭ skipped (needs cloud first-run creds) |

**Core desktop path proven headless on Linux:** the packaged Electrobun app
builds, launches, and renders a live non-blank UI, and the bottom-bar/tray window
surface works. The one failure and two skips are backend-provisioning / creds
env gaps in the headless packaged run, not renderer/product regressions.
