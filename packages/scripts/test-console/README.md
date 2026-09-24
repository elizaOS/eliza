# Local test console

Browser console for the repository's test inventory, credentials, runs, and
artifacts. It reads the same test plan as the repository runner.
No separate build is needed. Start from the repository root:

```bash
node packages/scripts/test-console/server.mjs
```

Test from the repository root:

```bash
bun run test:scripts
```
