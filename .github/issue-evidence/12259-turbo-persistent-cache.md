# Issue #12259 - Persistent Turbo tasks are uncached

PR scope:

- `turbo.json` now marks both persistent generic tasks, `dev` and `start`, with
  `cache: false`.
- No other Turbo pipeline behavior is changed in this slice.

Local verification on 2026-07-04:

```bash
node -e "const fs=require('fs'); const t=JSON.parse(fs.readFileSync('turbo.json','utf8')).tasks; if (t.dev.cache !== false || t.start.cache !== false) process.exit(1);"

node -e "JSON.parse(require('fs').readFileSync('turbo.json','utf8'));"

git diff --check origin/develop..HEAD
```

Screenshots/recordings: N/A, Turbo config only; no UI changed.
