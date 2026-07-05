# Issue #13692 Real Auth E2E Evidence

Scope covered by this PR:

- Web/desktop ui-smoke now drives the real `startApiServer` pair-code path.
- The spec starts a real runtime with `ELIZA_API_TOKEN`, enables pairing,
  forces loopback to act as auth-required with `ELIZA_REQUIRE_LOCAL_AUTH=1`,
  submits the server-side pair code through the rendered pairing UI, verifies
  the stored bearer is not the static API token, checks `/api/auth/status` and
  `/api/auth/me`, reloads, and verifies the shell stays unlocked.
- The test-auth contract now documents that first-run remote deep links carry
  URLs only, not bearer credentials or pair codes.

Artifacts:

- `playwright-real-pairing.log` - recorded passing Playwright run with real
  app-core server logs, pair-code emission, and `1 passed`.
- `real-pairing-ui-smoke.webm` - recorded browser walkthrough of pairing wall,
  pair-code submit, shell unlock, and reload persistence.
- `real-pairing-ui-smoke-finished.png` - manually reviewed final screenshot;
  pairing wall is gone and the chat composer is visible after reload.
- `real-pairing-ui-smoke-trace.zip` - Playwright trace for console/network/DOM
  inspection.
- `biome-check.log` - Biome check on changed files.
- `diff-check.log` - whitespace check on changed files.

N/A:

- Live LLM trajectory - no model/action/provider/prompt behavior changed.
- Android emulator/device proof - still requires the Android pairing lane and
  device artifacts from #13692's remaining acceptance criteria.
