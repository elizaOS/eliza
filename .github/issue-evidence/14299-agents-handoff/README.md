/**
 * Rendered evidence for #14299: the Agents console route exposes the Eliza app
 * handoff in both populated and empty table states.
 */

# #14299 Agents Handoff Evidence

Captured from current `origin/develop` at `7a47e823b5b` with the app renderer
built locally for the cloud audit.

## Commands

```bash
ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 \
ELIZA_AUDIT_CLOUD_STRICT=1 \
ELIZA_AUDIT_CLOUD_DIR=/tmp/eliza-issue14299-cloud-audit-current \
bun run --cwd packages/app audit:cloud --grep 'dashboard-agents (desktop|mobile)$'
```

Result: 2 passed, `broken=0`, `needs-work=0`, `needs-eyeball=2`.

Empty-state screenshots were captured from the same built renderer served by
`bun run --cwd packages/app preview -- --host 127.0.0.1 --port 4183`, with
`/api/v1/eliza/agents` stubbed to return an empty list. The capture log records
the successful API responses and console output.

## Artifacts

- `populated-desktop.png`
- `populated-mobile.png`
- `populated-desktop-hover.png`
- `empty-desktop.png`
- `empty-mobile.png`
- `audit-cloud-dashboard-agents-report.json`
- `audit-cloud-dashboard-agents-manual-review.md`
- `empty-state-capture-log.json`
