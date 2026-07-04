# Issue #12262 - clean/reset split

## Change

- Split root `clean` so it only runs Turbo clean plus local path removal.
- Added root `reset` for the old clean + install + build workflow.
- Updated root `CLAUDE.md` and `AGENTS.md` command docs.
- Added `reset` to the script-audit exact allowlist.

## Verification

Run on 2026-07-04:

- `node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); if (p.scripts.clean.includes('bun install') || p.scripts.clean.includes('bun run build')) throw new Error(p.scripts.clean); if (p.scripts.reset !== 'bun run clean && bun install && bun run build') throw new Error(p.scripts.reset); if (Object.keys(p.scripts).length !== 213) throw new Error(String(Object.keys(p.scripts).length));"`
- `node scripts/assert-agents-claude-identical.mjs`
- `node packages/scripts/audit-scripts.mjs`
- `git diff --check`
- `git diff --check origin/develop..HEAD`

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/docs script-surface change with no user interface.
