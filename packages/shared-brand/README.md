# @elizaos/shared-brand

Canonical brand assets shared across every elizaOS surface.

- **Logos** (`assets/logos/*.svg`) — every color/variant combo, sourced from the design master in `~/Desktop/brand/logos/`.
- **Cloud video** (`assets/clouds/*.{mp4,webm}` + `poster.jpg`) — the cloud loop in three playback speeds (1x, 4x, 8x), four resolutions (1080p/720p/480p/360p), and two codecs (H.264 MP4 with `+faststart`, VP9 WebM). `<an>` stripped, CRF-tuned for low-bandwidth streaming.
- **Tokens** (`src/index.ts`) — brand colors, surface themes, font stack, and the cloud-video manifest used by `<CloudVideoBackground>` in `@elizaos/ui`.

## How consumers use this

Asset bytes have to live inside each consumer's served `public/` tree (Vite, Mintlify, Electrobun all serve static files relative to their own root). To avoid stale duplicates, **never edit the synced copies** — edit `packages/shared-brand/assets/` and re-run sync.

```sh
# from a consumer package directory
node ../shared-brand/scripts/sync-to-public.mjs ./public
```

That drops `public/brand/logos/*.svg` and `public/clouds/*.{mp4,webm,jpg}` into the consumer. The consumer wires its `predev` / `prebuild` scripts to run that command so the bytes are always fresh:

```jsonc
// packages/<consumer>/package.json
{
  "scripts": {
    "predev": "node ../shared-brand/scripts/sync-to-public.mjs ./public",
    "prebuild": "node ../shared-brand/scripts/sync-to-public.mjs ./public"
  }
}
```

## Tokens

Per-surface theme classes live in `packages/ui/src/styles/base.css` (`.theme-cloud`, `.theme-os`, `.theme-app`). Import the tokens from `@elizaos/shared-brand` if you need them in JS:

```ts
import { BRAND_COLORS, SURFACE_THEMES, FONT_STACK } from "@elizaos/shared-brand";
```
