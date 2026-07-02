# #8434 cloud onboarding QA evidence

PR: #10627

Validated smoke-test code commit: `5a8687bd0b1487702fed6515c77c848269bd6197`

Evidence README commit: `d07d444e03747a7733b2c9d32f48f4b7a5ecef6b`

The final PR head adds this evidence README plus evidence-only corrections; the smoke-test code validated above is unchanged from `5a8687bd0b1487702fed6515c77c848269bd6197`.

Scope:
- Test-only update to `packages/app/test/ui-smoke/cloud-provisioning-startup.spec.ts`.
- Aligns the cloud provisioning startup smoke with the current floating first-run Cloud runtime chooser.
- Keeps the startup fixture fresh by returning `firstRunComplete: false`, no agents, and no defaults from `/api/config`.
- Falls back to the accessible `Create a new agent` button name when the older `onboarding-agent-create` test id is absent.

Validation run on 2026-07-01:
- `git diff --check origin/develop...HEAD` -> pass.
- `bunx biome check packages/app/test/ui-smoke/cloud-provisioning-startup.spec.ts` -> pass.
- `bun run --cwd packages/shared build:i18n` -> generated the local shared i18n artifact required by the focused unit test.
- `bun test packages/ui/src/api/app-shell-capabilities.test.ts` -> pass, 4 tests.
- `bun run --cwd packages/core build` -> pass.
- `bun run --cwd packages/shared build` -> pass.
- `ELIZA_UI_SMOKE_PORT=42138 ELIZA_UI_SMOKE_API_PORT=42137 ELIZA_UI_SMOKE_DISABLE_VIDEO=1 bunx playwright test --config playwright.ui-smoke.config.ts test/ui-smoke/first-run-startup.spec.ts test/ui-smoke/cloud-provisioning-startup.spec.ts --project=chromium` -> pass, 6 Chromium tests.

Playwright coverage:
- `cloud provisioning reaches chat from startup on mobile`
- `cloud provisioning reaches chat from startup on desktop`
- `cloud provisioning reaches chat from startup on wide-web`
- `new cloud agent provisions through direct cloud sandbox and reaches chat`
- `first-run chooser renders without a render loop and lets the runtime be chosen`
- `fresh first-run offers to restore an existing local backup before onboarding`

Artifacts not applicable:
- Full app aesthetic audit: N/A, this PR changes only a Playwright smoke test, not app UI implementation or styling.
- Live OAuth/Google sign-in: N/A for this deterministic startup compatibility smoke; live private-account staging sign-in remains an operator/manual account proof.
