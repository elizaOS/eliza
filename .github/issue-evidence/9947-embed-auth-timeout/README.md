# #9947 embed auth timeout follow-up

Follow-up to the merged embed client bootstrap (#10653). The `/embed` SPA
authenticates before mounting by posting the platform launch payload to
`/api/embed/auth`. Without a timeout, a stalled iframe/network request could
leave the app blank indefinitely instead of mounting in the unauthenticated
fallback state.

## Change

- Bound the embed auth request with a 10s timeout.
- Abort the fetch when supported.
- Return `network_timeout` without installing a token when the request never
  resolves.

## Validation

Run from `/tmp/eliza-pr-9947-timeout`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build:core
bun run --cwd packages/app test src/embed-bootstrap.test.ts
bunx @biomejs/biome check packages/app/src/embed-bootstrap.ts packages/app/src/embed-bootstrap.test.ts .github/issue-evidence/9947-embed-auth-timeout/README.md
git diff --check origin/develop...HEAD
```

The connector URL-tagging tests were already validated on the merged #10653
branch before this follow-up was split out; this PR only changes the app
bootstrap timeout path.
