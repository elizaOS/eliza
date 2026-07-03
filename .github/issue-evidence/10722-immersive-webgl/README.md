# #10722 — immersive-WebGL larp: reconciled + verified

## What the larp was

`WEBXR_PLATFORMS.md` contained two contradicting sections:

- **Validated** (line 38) claimed `enterImmersiveScene()` was proven end-to-end
  and read the session framebuffer back with `gl.readPixels()` — with a
  committed, re-runnable test.
- **NOT yet validated (#10722 — do not claim otherwise)** (lines 44–53) claimed
  the exact opposite: no IWER-emulator run opens an immersive session or reads
  the framebuffer back, and no `setHandPose`/gaze test exists.

## Ground truth (verified this session)

The real test **does** exist and is committed + CI-gated — it landed in
`936d42e086` (PR #11003), which also updated the *Validated* list but left the
stale *NOT yet validated* section behind.

- `packages/ui/src/spatial/__e2e__/run-immersive-e2e.mjs` + `immersive-fixture.ts`
  drive the **real** `enterImmersiveScene()` export against an IWER-emulated
  Quest 3 in **headless Chromium, real WebGL2** (SwiftShader), and assert with
  `gl.readPixels()` on the session framebuffer.
- Wired into CI: `.github/workflows/test.yml:293` (`test:immersive-e2e`) +
  artifact upload.
- Hand/gaze driven through live IWER:
  `plugins/plugin-xr/simulator/e2e/{hand,gaze}-input.spec.ts` (real
  `setHandPose`/select asserts).

### Local run — 43/43 assertions green

```
$ bun run --cwd packages/ui test:immersive-e2e
✓ navigator.xr present (IWER runtime installed)
✓ origin-unclean canvas upload really throws SecurityError (threw=true, name=SecurityError)
✓ 3 panels drawn per eye = 6 quads/frame (6)
✓ [left]  green canvas texture at predicted pixel — not the red fallback (0,255,0,255)
✓ [left]  content panel card background reads magenta (255,0,255,255)
✓ [left]  content panel accent rule reads brand orange (255,88,0,255)
✓ [left]  tainted-source panel renders the solid fallback tone (255,153,0,255)
✓ [right] green canvas texture at predicted pixel — not the red fallback (0,255,0,255)
✓ ipd parallax between eyes on the same world point (12.0px)
✓ refreshTextures re-uploaded the repainted canvas (now yellow) (255,255,0,255)
✓ no dangling RAF loop after end() — frame counter frozen (32 → 32)
✓ a new immersive session is grantable after end() (previous session released)

IMMERSIVE E2E PASSED
```

Screenshots (session framebuffer, headless-chromium WebGL2):

- `01-immersive-stereo.png` — stereo render, three panels per eye.
- `02-immersive-refreshed.png` — after `refreshTextures()` (green → yellow).

## The fix

Path A (land the real test) was already satisfied by #11003 — verified above.
This change removes the reverse larp: the stale *NOT yet validated* section is
replaced with an honest *Known gap* note. The one fact that is still true is
kept: `enterImmersiveScene` / `enterImmersiveFromSpecs` have **no production UI
caller** yet (public `@elizaos/ui/spatial` exports, exercised by the e2e; the
"enter immersive" UI surface is hardware-gated on a headset + OpenXR runtime and
lands with the native desktop-immersive work). The render path is proven; it is
not claimed *shipped to users*.
