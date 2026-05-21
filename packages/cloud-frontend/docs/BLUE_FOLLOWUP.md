# Blue followup — `@elizaos/ui` components

The cloud-frontend `src/` tree is now blue-free (verified by grep + the
runtime `tests/e2e/blue-banned.spec.ts` check). Remaining blue lives in
the shared `@elizaos/ui` package's cloud-ui subdir. These components are
consumed by cloud-frontend, so the visual leak is still real — but
fixing them is a sweep through a different package that wasn't in this
session's scope.

## Files still containing blue (as of 2026-05-21)

| File | What's blue | Suggested replacement |
| --- | --- | --- |
| `packages/ui/src/cloud-ui/components/log-viewer.tsx:133,157` | `info` log severity → `text-blue-300 border-l-blue-500` | Neutral: `text-white/70 border-l-white/30` |
| `packages/ui/src/cloud-ui/components/glowing-stars.tsx:160` | `bg-blue-500 shadow-blue-400` decorative | Orange or white; this is a decorative effect, pick from brand palette |
| `packages/ui/src/cloud-ui/components/timeline.tsx:90` | `via-blue-500` gradient stop | `via-orange-500` or remove |
| `packages/ui/src/cloud-ui/components/promote-app-dialog.tsx:236,241,249,263,446` | Selected-state highlight for "social" channel option | Orange-accent: `border-orange-500/50 bg-orange-500/10 text-orange-300` |

Already handled in this session:

- `connection-card.tsx` — `tone="blue"` callout remapped to neutral
  `bg-white/5 border-white/15 text-foreground`. Three settings pages
  (`microsoft-connection.tsx`, `telegram-connection.tsx`,
  `whatsapp-connection.tsx`) still pass `tone="blue"` but now render
  correctly thanks to the source-level remap; the prop name can be
  renamed to `"info"` in a future cleanup pass.

## CSS variables

`packages/ui/src/styles/theme.css` has been edited so that
`--brand-blue` (still defined for legacy callers) resolves to a neutral
black/white opacity instead of `#0b35f1`. `--status-success` and
`--status-info` were remapped off blue. The dist file
`packages/ui/dist/styles/theme.css` is stale — running the package's
build (or any consumer rebuild) will refresh it.

## Verification

Run `bun run --cwd packages/cloud-frontend test:e2e -- blue-banned`
after the @elizaos/ui rebuild lands. The source-grep portion already
passes; the runtime check will catch any remaining `var(--brand-blue)`
fallthrough.
