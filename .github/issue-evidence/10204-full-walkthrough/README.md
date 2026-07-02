# Evidence — #10204 full end-to-end walkthrough generator

Branch: `feat/10204-walkthrough-viewer`

## What #10204 needed vs. what existed

The full-walkthrough **tooling** already shipped in #10249 — `full-walkthrough.spec.ts`
(the 25-step journey), the per-step `WalkthroughRecorder`, ffmpeg MP4 stitching,
contact sheets, and `walkthrough-device-matrix.mjs`. The issue was **reopened**
because no reviewed **artifact bundle** was produced and the per-step report
lacked the video-timestamp linkage the acceptance criteria call for.

This PR closes both gaps:

1. **Per-step report viewer** (`walkthrough-e2e.mjs` → `writeViewerHtml`): the
   viewer was a bare video + contact-sheet link. It is now a **per-step
   dashboard** that renders, for every step, a screenshot thumbnail → full image,
   the route, the expectation, the assertion list, console/5xx error badges, the
   gate summary, and a **"▶ M:SS" link that seeks the stitched MP4 to that step**
   (`frameIndex × 2.6s` dwell). `copyViewportArtifacts` makes the bundle
   self-contained. A new `--viewer-only <runId>` re-renders the report from an
   existing capture without re-walking.
2. **Mock-lane gate cleanliness** (`journey.ts`): the keyless lane 501'd the
   optional character-VRM avatar HEAD probe on nearly every step, tripping the
   diagnostics gate on benign noise. It's now answered `404` ("no custom avatar")
   — the same graceful fallback the app already handles — so the run fails only
   on **real** errors.
3. **A real, reviewed artifact bundle** (below), captured on this host.

## Artifact bundle (web/desktop, keyless mock lane)

Produced by `bun run --cwd packages/app test:e2e:walkthrough` (Node 24), reviewed
by hand:

- `walkthrough-desktop.mp4` / `walkthrough-mobile.mp4` — the human-speed video
  walkthroughs of the full 25-step journey (cold launch → in-chat onboarding →
  tutorial → help → settings → wallet → chat round-trip → character edit →
  new-chat → launcher → chat-over-view → dashboard).
- `contact-sheet-desktop.png` / `contact-sheet-mobile.png` — every captured
  frame, tiled (the full-res per-step PNGs live in the gitignored run dir; kept
  out of the repo for size — regenerate with `--viewer-only <runId>`).
- `viewer.html` — the per-step dashboard: each card carries the route, the
  assertion list, console/5xx badges, and a **jump to that moment in the video**.
  (Thumbnails point at the run-dir PNGs, so open it against a local run for
  images; the per-step data + jump links work standalone.)
- `<viewport>/steps.json` — the per-step manifest (route, viewport, DOM markers,
  assertions, per-step `newConsoleErrors` / `newServerErrors`, the run `gate`
  result, timestamps). The console/network `.log` files stay gitignored; their
  gated contents are surfaced here (both empty this run — a green gate).

**Manual review:** all **25 steps captured on both viewports, none skipped**, and
**both gates are green** (`ok: true`, 0 console/page errors, 0 5xx — see each
`steps.json` `gate`). The previously-benign `501/404 HEAD /api/avatar/vrm` noise
is cleared by this PR's mock-lane fix.

## Platform matrix status

| Lane | Status |
| --- | --- |
| Web/desktop (Chromium, mock) | ✅ captured — this bundle |
| Web/desktop (live real-model) | Runnable via `test:e2e:walkthrough:live` with a provider key; not captured on this host (keyless) |
| iOS simulator | Command exists (`test:e2e:walkthrough:ios`); requires macOS + a booted sim + a fresh build — **not captured here** (build/sim contention on this host). `DEVICE_MATRIX.md` documents prereqs + skip reasons. |
| Android emulator | Command exists (`test:e2e:walkthrough:android`); requires adb + AVD + an `ELIZA_WEBVIEW_DEBUG` APK — **not captured here**. |

The iOS/Android lanes are wired (`walkthrough-device-matrix.mjs`, `DEVICE_MATRIX.md`)
but their **captures** need on-device runs on a built app and remain the
device-lane follow-up per `PR_EVIDENCE.md`.

## Reproduce

```bash
# keyless mock (this bundle):
ELIZA_NODE_PATH=$(command -v node) bun run --cwd packages/app test:e2e:walkthrough
# re-render just the viewer for an existing run:
node packages/app/scripts/walkthrough-e2e.mjs --viewer-only <runId>
```
