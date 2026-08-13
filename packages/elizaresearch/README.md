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
- `assets/syne-latin.woff2` is the local Latin web subset of
  [Syne](https://gitlab.com/bonjour-monde/fonderie/syne-typeface), designed for
  Synesthésie by Bonjour Monde and Lucas Descroix and released under the SIL
  Open Font License 1.1. SHA-256:
  `cfff412005eed2f0152d1c110c78ac564642b943e64322fbd687083177d6fa70`.
- Geist and the Eliza logo/product artwork were already included with Shaw's
  Eliza Research package. Runtime pages load no remote font or image assets.

The privacy and terms routes are intentionally transparent placeholders for
local comparison only. No legal text, team biographies, contact submission, or
unsupported product claim is fabricated.
