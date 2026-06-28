# Aesthetic + UX review — EDAD (`packages/examples/cloud/edad`)

**Verdict: `good`** (redesigned with generated art) · reviewed live (desktop
1280×900 + mobile 390×844) AND in the CI-built container image, agent (Claude)
screenshot + critique. Human sign-off: _pending_.

Screenshots: [`edad-desktop.png`](edad-desktop.png) ·
[`edad-desktop-journey.png`](edad-desktop-journey.png) ·
[`edad-mobile.png`](edad-mobile.png) ·
[`edad-container.png`](edad-container.png) (served from the GHCR-style Docker image) ·
walkthrough [`edad-journey.webm`](edad-journey.webm).

## What changed (#9300 finish pass)

The app shipped with **emoji avatars** (`👨` / `🫵`) and a generic black
silhouette — inconsistent with eDad's own "never use emoji" voice and flat for a
public showcase. Replaced with real generated artwork (authored as crisp,
self-contained **SVG** via the `codex` CLI, then rasterized for raster-only slots
with `rsvg-convert`):

| asset | where | notes |
| --- | --- | --- |
| `dad-portrait.svg` | sidebar hero | warm, friendly eDad — open kind eyes, gold round glasses, grey mustache, gentle smile, dark+gold backdrop |
| `dad-avatar.svg` | every eDad chat bubble | tight circle-safe headshot of the same character, legible at 34px |
| `you-avatar.svg` | the user's chat bubble | neutral cream person silhouette with a gold ring — no emoji |
| `favicon.svg` + `favicon.png` + `apple-touch-icon.png` | browser tab / home screen | gold "eD" serif monogram on a dark tile |
| `og-image.png` (1200×630) | social card | gold "eDad" wordmark + tagline + portrait + "powered by eliza cloud" |

`index.html` now wires the portrait, both chat avatars, favicons, and full
OpenGraph/Twitter card meta; `style.css` renders the portrait + circular image
avatars (dropping the old sepia/grayscale filter and the emoji font slot).

> An initial generation pass produced an uncanny face (closed gold "eyes", pale
> mask); it was regenerated with explicit art direction (open eyes, warm
> complexion, glasses + mustache). The committed assets are the second pass.

## Brand / color

- **Palette intact:** near-black `#0b0b0d`, warm cream `#ebe6d9`, gold `#c79a3f`.
  Gold is the only accent; **no blue anywhere** (verified by computed-style scan).
- **No emoji** anywhere now — consistent with eDad's voice.
- The portrait/avatars use the same gold rim-light + warm tones as the UI, so they
  read as part of the design, not pasted on.

## UX / flow (no dead ends)

- **Landing** renders the portrait + brand + traits + composer cleanly.
- **Login-gated send journey:** sending while signed-out shows the user's bubble
  (with the new `you-avatar`), flips status to ERROR, and replies in character —
  "dad needs you to sign in with eliza cloud. click the button up top, kiddo." —
  with the sign-in CTA present. Graceful, no dead end.
- **Responsive:** mobile collapses the sidebar to a header (portrait + wordmark)
  with no layout break.
- **Console:** 0 warnings/errors; all 4 in-page images load (`naturalWidth > 0`).

## CI build + deploy (verified)

- The GHCR build (`.github/workflows/build-example-app-images.yml`) bundles
  `server.ts` (SDK inlined) + copies `public/`, so the new assets bake into
  `ghcr.io/elizaos/example-edad:showcase`. I added a **smoke-test gate** to that
  workflow: it builds the image, runs the container, and asserts `/health`,
  `GET /` (serves the UI) and `/api/config` before pushing — so the showcase
  deploy can never pull a broken tag.
- **Verified locally end-to-end:** built the exact bundle + `Dockerfile.bundle`
  image with Docker, ran it, and confirmed it is `healthy` and serves the new UI +
  all six image assets (`dad-portrait.svg`, `dad-avatar.svg`, `you-avatar.svg`,
  `favicon.svg`, `og-image.png`, `apple-touch-icon.png` → all `200`). The
  containerized render is [`edad-container.png`](edad-container.png).
- **Live cloud deploy** (pull the GHCR image onto a real Hetzner node behind
  `<shortid>.apps.elizacloud.ai`) remains the operator-gated nightly path
  (`MONETIZED_LOOP_REAL=1` + secrets) — runbook in
  `packages/test/cloud-e2e/docs/showcase-apps-coverage.md`.

## Findings

- None blocking. (Full provider-keyed chat needs `ELIZA_APP_ID` + a signed-in
  user; covered by the showcase e2e loop + `DEPLOY_AND_VALIDATE.md`.)
