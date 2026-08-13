# elizaresearch.ai

Static company site for Eliza Research with no framework or build step. The
primary page and every local Reflow study share one particle engine.

- Preview locally: `bun run preview` (serves on :4173)
- Primary site: `/`
- Three-cut review: `/reflow-compare`
- Reflow route families: append `?edition=rail`, `?edition=field`, or
  `?edition=index` to `/reflow`, `/reflow-about`, `/reflow-team`,
  `/reflow-contact`, `/reflow-animation`, `/reflow-privacy`, and
  `/reflow-terms`.
- All comparison routes are `noindex`, remain outside the production
  navigation, and are local review artifacts rather than a selected site.
- `.assetsignore` keeps the review HTML/CSS, design notes, package metadata,
  and unused Latin Extended font subset out of the Worker asset manifest. The
  shared content renderer and particle engine remain deployable because `/`
  consumes both.
- Deploy: `bun run deploy` — Cloudflare Workers static assets (worker
  `elizaresearch`) with `elizaresearch.ai` as an auto-managed custom domain.

Products described: **Eliza** (a personal agent powered by open source elizaOS)
and **slop.cash** (a swarm contribution platform).

## Design and asset provenance

- The particle-mask interaction descends from NubsCarson/reflow commit
  `1e65f064e5ef57472b90eadc06dd30d02fa12c58`, whose Canvas2D implementation
  closely follows rauchg's v0 template
  [Logo particles (v0 + aws)](https://v0.app/templates/AdFqYlEFVdC).
- The grouped entrance adapts Shaw's Eliza Research formation merged into
  elizaOS/eliza. The local version replaces links, radial repulsion, and large
  wobble with dense round dots, a directional cursor bend, and sub-pixel living
  motion.
- `assets/geist-sans-latin.woff2` is Google Fonts' Latin WOFF2 subset of
  [Geist 1.401](https://github.com/vercel/geist-font/releases/tag/1.4.01),
  released under the SIL Open Font License 1.1. Its exact CDN source is
  `https://fonts.gstatic.com/s/geist/v4/gyByhwUxId8gMEwcGFWNOITd.woff2`.
  SHA-256:
  `a29f900a6d603e989449327956e7ac61ea3e6b26ca7426f64e7cccf2cd4aed37`.
  The pinned notice and license are in
  [`assets/licenses/geist-OFL-1.1.txt`](assets/licenses/geist-OFL-1.1.txt).
- `assets/syne-latin.woff2` is Google Fonts' Latin WOFF2 subset of
  [Syne 2.200](https://gitlab.com/bonjour-monde/fonderie/syne-typeface/-/commit/d9098c0a72125d411dbb225a2e5a61dc15265ffc),
  released under the SIL Open Font License 1.1. Its exact CDN source is
  `https://fonts.gstatic.com/s/syne/v24/8vIH7w4qzmVxm2BL9G78HEY.woff2`.
  SHA-256:
  `cfff412005eed2f0152d1c110c78ac564642b943e64322fbd687083177d6fa70`.
  The pinned notice and license are in
  [`assets/licenses/syne-OFL-1.1.txt`](assets/licenses/syne-OFL-1.1.txt).
- `assets/geist-sans-latin-ext.woff2` is the matching Geist Latin Extended
  subset. This package no longer loads it and `.assetsignore` excludes it from
  deployment. SHA-256:
  `f7604a53a00250f66db4b47dd44327ce2a43f6edec850d5217bb80238819efdd`.
- The Eliza logo and product artwork came from Shaw's Eliza Research package.
  Runtime pages load no remote font or image assets.

The privacy and terms routes are intentionally transparent placeholders for
local comparison only. No legal text, team biographies, contact submission, or
unsupported product claim is fabricated.

`hello@elizaresearch.ai` is preserved from the supplied site copy for the
copy-email interaction, but inbound routing is not verified in this preview.
GitHub and X are presented as available contact alternatives.
