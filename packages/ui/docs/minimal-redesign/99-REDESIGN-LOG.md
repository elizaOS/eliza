# Redesign log (per-view verdicts)

Verdicts: `good` · `needs-work` · `broken`. Newest at bottom.

## P0 — foundation
- **Single light look** — pinned `resolveUiTheme`/`getSystemTheme` to `light` (packages/ui/src/state/persistence.ts); removed dark/light/system toggle from Appearance settings. Verdict: good.
