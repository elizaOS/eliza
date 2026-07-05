# #13624 audit:cloud fail-closed evidence

## Change

- `audit:cloud` no longer whole-suite-skips when Playwright test auth is missing.
- `audit:cloud` now writes `report.json` even for zero findings and fails on zero findings, `broken`, or `needs-work`.
- `run-ui-playwright.mjs` removes `packages/app/dist` before `--project=audit-cloud` when `VITE_PLAYWRIGHT_TEST_AUTH=true`, unless `ELIZA_UI_SMOKE_SKIP_BUILD=1` is explicitly set.

## Verification

```bash
bunx biome check packages/app/test/ui-smoke/cloud-surfaces-aesthetic-audit.spec.ts packages/app/scripts/run-ui-playwright.mjs packages/app/playwright.ui-smoke.config.ts
node --check packages/app/scripts/run-ui-playwright.mjs
git diff --check
```

All passed.

Runner stale-dist probe:

```bash
mkdir -p packages/app/dist
printf 'stale-auth-build\n' > packages/app/dist/.audit-cloud-stale-marker
ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1 \
ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1 \
VITE_PLAYWRIGHT_TEST_AUTH=true \
node packages/app/scripts/run-ui-playwright.mjs \
  --config playwright.ui-smoke.config.ts \
  --project=audit-cloud \
  --help
test ! -e packages/app/dist/.audit-cloud-stale-marker
```

Passed. The runner printed:

```text
[ui-smoke] Removing app dist before audit-cloud so VITE_PLAYWRIGHT_TEST_AUTH is baked into a fresh renderer build.
```

Full audit attempt:

```bash
bun run --cwd packages/app audit:cloud
```

Result: failed before Playwright screenshots during the pre-run `@elizaos/core`
build. The run did reach the new stale-dist invalidation line above, then
`@elizaos/core` declaration generation failed on existing dependency/type
resolution errors:

```text
src/features/advanced-capabilities/personality/services/character-file-manager.ts(12,16): error TS7016: Could not find a declaration file for module 'fs-extra'.
src/features/plugin-manager/services/coreManagerService.ts(17,16): error TS7016: Could not find a declaration file for module 'fs-extra'.
src/features/plugin-manager/services/pluginManagerService.ts(21,16): error TS7016: Could not find a declaration file for module 'fs-extra'.
src/markdown/ir.ts(15,24): error TS7016: Could not find a declaration file for module 'markdown-it'.
src/media/mime.ts(26,34): error TS2307: Cannot find module 'file-type' or its corresponding type declarations.
```

No `aesthetic-audit-output-cloud` screenshot or manual-review artifacts were
produced because the failure happened before the Playwright server started.

## PR_EVIDENCE rows

- UI screenshots/video: N/A - fail-closed audit harness behavior, no product UI pixels changed.
- Real-LLM trajectories: N/A - no agent/action/provider/model behavior changed.
- Audio artifacts: N/A - no voice/TTS/STT behavior changed.
- Domain artifacts: N/A - no DB, memory, wallet, chain, or generated domain artifact changed.
- Full `audit:cloud` rendered run: blocked before screenshots by the
  `@elizaos/core` declaration-resolution errors listed above; this patch makes
  the audit fail closed once it reaches the rendered walk.
