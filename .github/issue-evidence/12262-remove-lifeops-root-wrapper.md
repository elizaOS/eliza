# Evidence: #12262 remove LifeOps root wrapper

Date: 2026-07-04

## Change

- Deleted root `test:lifeops`.
- Documented the replacement as `bun run test:plugin 'plugin-personal-assistant'`.
- Updated root `CLAUDE.md` / `AGENTS.md` script count and migration table.

Screenshots/recordings: N/A. This is a root script/docs cleanup with no UI behavior change.

## Verification

```bash
node -e "const p=require('./package.json'); if (Object.hasOwn(p.scripts,'test:lifeops')) throw new Error('test:lifeops still exists'); if (Object.keys(p.scripts).length !== 207) throw new Error('script count '+Object.keys(p.scripts).length); console.log('test:plugin body:', p.scripts['test:plugin']); console.log('lifeops wrapper deletion assertions passed')"
# test:plugin body: node packages/scripts/run-all-tests.mjs --only=e2e --pattern
# lifeops wrapper deletion assertions passed
```

```bash
node scripts/assert-agents-claude-identical.mjs
# [assert-agents-claude-identical] PASS: 301 tracked CLAUDE.md/AGENTS.md pair(s) are byte-identical.
```

```bash
node packages/scripts/audit-scripts.mjs
# [audit-scripts] OK - no orphan/no-op/broken scripts.
```

```bash
grep -RIn "test:lifeops" .github docs packages plugins scripts CLAUDE.md AGENTS.md package.json
# Remaining hits are the root migration docs and historical #10200 evidence.
```

```bash
git diff --check
# no output
```
