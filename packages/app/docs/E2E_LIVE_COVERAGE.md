# Application test lanes

Application validation is organized by trust boundary, not by one workflow per
feature.

## Pull requests

`.github/workflows/ci.yml` is the canonical required pull-request workflow. Its
`Tests` and `Smoke` jobs call the repository-level package sweeps and
deterministic E2E suite. Path classification can skip unaffected groups, while
the stable `Required` job remains the only status intended for branch
protection. Specialized and path-scoped workflows may add checks for the
surfaces they own.

The pull-request lane is credential-free. It uses deterministic model fixtures,
local services, and checked-in browser fixtures. A test that requires a hosted
model, Railway service, production account, physical device, or store signing
does not belong in this lane.

## Nightly

`.github/workflows/nightly.yml` reuses the consolidated CI workflow and adds
macOS and Windows platform smoke. It does not publish packages or deploy
infrastructure.

## Live services

`.github/workflows/live-smoke.yml` is the general manual dispatcher. Its input
selects `app`, `scenarios`, `cloud`, `voice`, or `all`. Specialized
`app-live-e2e.yml` and `voice-live-e2e.yml` jobs retain their own scheduled and
manual evidence. Credential-backed failures are therefore visible without
making the canonical required status depend on secret availability or
third-party uptime.

## Platform and release evidence

iOS, Android, desktop packaging, store signing, and physical-device evidence
remain package-owned. Path-scoped pull-request checks cover deterministic
software contracts; operators still run the hardware and signed-artifact
commands in `packages/app` and `packages/app-core` for release evidence.

Run the narrow package command while developing, then use the repository gates
before review:

```bash
bun run --cwd packages/app test
bun run --cwd packages/app test:e2e
bun run --cwd packages/app audit:app
bun run verify
```
