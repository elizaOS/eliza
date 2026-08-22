# Application test lanes

Application validation is organized by trust boundary, not by one workflow per
feature.

## Pull requests

`.github/workflows/pr-static-smoke.yml` is the sole pull-request and merge-group
workflow. It publishes the stable `All Tests Passed` status after mergeability,
diff, secret, workflow-syntax, frozen-install, core-build, and affected static
checks. Full repository tests and deterministic E2E run after merge through the
develop validation authority, not on pull requests.

The pull-request lane is credential-free. It uses deterministic model fixtures,
local services, and checked-in browser fixtures. A test that requires a hosted
model, Railway service, production account, physical device, or store signing
does not belong in this lane.

## Nightly

`.github/workflows/nightly.yml` reuses the consolidated CI workflow and adds
macOS and Windows platform smoke. It does not publish packages or deploy
infrastructure.

## Live services

`.github/workflows/live-smoke.yml` is the general credential-backed dispatcher.
The dispatch input selects `app`, `scenarios`, `cloud`, `voice`, or `all`.
Credential-backed failures are therefore visible without making ordinary
repository health depend on secret availability or third-party uptime.
Specialized app and voice evidence also flows through `app-live-e2e.yml` and
`voice-live-e2e.yml`, which run on schedule or dispatch.

## Platform and release evidence

iOS, Android, desktop packaging, store signing, and physical-device evidence
are operator-run release checks. Their commands remain in `packages/app` and
`packages/app-core`; they are not automatic pull-request fan-out.

Run the narrow package command while developing, then use the repository gates
before review:

```bash
bun run --cwd packages/app test
bun run --cwd packages/app test:e2e
bun run --cwd packages/app audit:app
bun run verify
```
