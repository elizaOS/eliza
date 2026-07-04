# Evidence: #12262 guard root cwd wrappers

Date: 2026-07-04

## Change

- Added a root script audit check for exact `bun run --cwd <dir> <script>` wrappers.
- Kept intentional product/CI root entrypoints in an explicit allowlist with written reasons.
- Added self-test coverage proving an unallowlisted wrapper fails and an allowlisted wrapper passes.

Screenshots/recordings: N/A. This is a script-audit guard change with no UI behavior change.

## Verification

```bash
node packages/scripts/audit-scripts.self-test.mjs
# audit-scripts self-test passed
```

```bash
node packages/scripts/audit-scripts.mjs
# [audit-scripts] OK - no orphan/no-op/broken scripts.
```

```bash
git diff --check
# no output
```
