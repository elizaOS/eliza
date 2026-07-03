# Issue #10450 - raw app create repo default

## What changed

- `POST /api/v1/apps` now provisions a GitHub repo only when the request
  explicitly sends `skipGitHubRepo: false`.
- Omitting `skipGitHubRepo` now follows the no-repo/template-image path, matching
  the dashboard and agent front doors and avoiding accidental first-party private
  repository creation from raw API callers.
- The explicit repo-backed path remains available for callers that opt in with
  `skipGitHubRepo: false`.

This PR addresses the locally testable raw app-create hardening slice from issue
#10450. The X-App-Id org-scope rule and per-org app creation cap still need a
product/auth policy decision before implementation.

## Validation

Base commit: `8e5d7797f0 test(screencapture): extract + device-test the recording config resolver (#9967) (#10453)`

Commands run from `/home/shaw/eliza/eliza-issue-10450`:

```bash
bun run install:light
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/core build:node
git diff --check
bunx @biomejs/biome check packages/cloud/api/v1/apps/route.ts packages/cloud/api/__tests__/apps-crud.integration.test.ts packages/cloud/shared/src/lib/services/__tests__/app-factory.test.ts
bun test packages/cloud/api/__tests__/apps-crud.integration.test.ts --reporter=dot
bun test packages/cloud/shared/src/lib/services/__tests__/app-factory.test.ts --reporter=dot
```

Observed results:

- `git diff --check`: passed.
- Biome focused check: `Checked 3 files in 64ms. No fixes applied.`
- API integration suite: passed with `39 pass`, `0 fail`, `111 expect() calls`.
- Shared app factory suite: passed with exit code 0; dot reporter showed 10
  passing tests before the repository coverage table.

The two test files were run separately. Running them in one Bun invocation caused
test-module mock state from the API integration suite to contaminate the shared
factory suite, so the separate runs are the valid signal for these focused files.

## Human-verifiable behavior

- Raw API body with no `skipGitHubRepo` now calls the app factory with
  `createGitHubRepo: false` and returns no `githubRepo`.
- Raw API body with `skipGitHubRepo: true` continues to return no `githubRepo`.
- Raw API body with `skipGitHubRepo: false` calls the app factory with
  `createGitHubRepo: true` and returns the created repo name.
- Factory-level deploy resolution confirms the default raw body stamps the
  template image and resolves, while explicit repo opt-in still follows the
  repo-backed build-from-repo-disabled failure path.

Screenshots/video/Android capture: N/A. This is a cloud backend route-contract
change with no UI, native, or device surface.
