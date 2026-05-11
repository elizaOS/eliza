# Repo Cleanup Dry Run Summary - 2026-05-11

Status: dry run complete. No cleanup implementation was performed.

## Files Created

- `README.md`
- `wave-01-search-pollution-generated-artifacts.md`
- `wave-02-lifeops-health-contracts.md`
- `wave-03-backend-route-ownership.md`
- `wave-04-frontend-state-ui.md`
- `wave-05-test-cleanup.md`
- `wave-06-assets-docs-artifacts.md`
- `wave-07-naming-text-cleanup.md`
- `wave-08-final-validation-signoff.md`

## Non-Destructive Confirmation

The dry run only created markdown under:

```text
docs/audits/repo-cleanup-2026-05-11/
```

No source, config, package, test, asset, route, generated output, or existing markdown file was intentionally changed by the cleanup dry run. The worktree already contains many unrelated modified and untracked files, so implementation must preserve those changes and avoid broad reset/checkout operations.

## Cross-Wave Implementation Dependencies

Although the dry-run research ran in parallel, implementation should use these dependency rules:

1. Wave 8 baseline/signoff setup comes first.
2. Wave 1 generated-artifact cleanup can proceed early, but only after baseline manifests and owner approval for tracked generated outputs.
3. Wave 2 LifeOps/Health contract cleanup must land before Wave 7 removes `contract-stubs` naming.
4. Wave 3 route ownership must land before Wave 7 renames or deletes `fallback`/compat route files.
5. Wave 4 frontend state refactors should land in small batches with browser verification after each batch.
6. Wave 5 test deletion must follow replacement coverage decisions for behavior that matters.
7. Wave 6 asset/docs deletion requires product/owner decisions before any tracked asset, model, dataset, benchmark output, or audit markdown is removed.
8. Wave 7 naming cleanup should be last for risky public names, but safe comment/file-name edits can land earlier.

## Highest-Risk Owner Decisions

- Whether tracked cloud public assets, fonts, companion VRM/FBX files, platform splash images, and large generated reports stay in git or move to CDN/object storage/release artifacts.
- Whether `plugins/app-lifeops/src/lifeops/context-graph.ts` is a real supported surface or should be removed/quarantined under the one-graph-store invariant.
- Whether plugin-health may import canonical LifeOps contract modules, or whether shared contracts must move outside app-lifeops.
- Compatibility windows for backend/cloud route aliases and fallback route files.
- Markdown retention policy: only READMEs/docs-site docs, or a small curated archive index for historical audit docs.
- Test policy for mock-heavy tests: delete, convert to integration/e2e, or keep with explicit purpose.

## Validation Contract

Implementation is not signed off until Wave 8 reports pass:

```bash
export BUN=/Users/shawwalters/.bun/bin/bun
export NODE_OPTIONS=--max-old-space-size=8192

$BUN run lint:check
$BUN run typecheck
$BUN run test:ci
$BUN run test:e2e
$BUN run test:launch-qa
$BUN run audit:package-barrels
$BUN run knip -- --no-exit-code
$BUNx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
```

Per-wave scoped validation is listed in each wave report.

## Approval Path

Recommended approval sequence:

1. Review this summary and the eight wave reports.
2. Decide the owner questions listed above.
3. Approve Wave 8 baseline/signoff setup first.
4. Approve one implementation batch at a time with a deletion/rename manifest.
5. Require a validation result in every batch before moving to the next.

