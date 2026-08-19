# Bundle-first evidence review

The normal evidence path is one integrity-checked bundle:

```bash
bun run test:matrix                 # producers -> bundle -> verify -> review
bun run evidence:review:no-open     # review newest finalized bundle
bun run evidence:review:no-open -- --bundle=evidence/runs/<run-id>
```

`test:matrix` always passes its exact newly-created bundle to the reviewer. It
does not select “latest,” so a stale or concurrent run cannot replace the
evidence being reviewed. Before any lane runs it hashes the named producer
inventory; bundle creation then admits only new or written/replaced files, so a
skipped lane contributes zero stale artifacts. The standalone zero-argument review command selects
the newest finalized bundle as a convenience. In both cases the canonical
`@elizaos/evidence` verifier checks artifact bytes, sizes, hashes, provenance,
unlisted files, and symlinks before the dashboard is written.

`--source=<dir>` is an explicit compatibility escape hatch for archived or
ad-hoc material. It may be repeated and may accompany `--bundle`; no producer
directory is scanned implicitly. Compatibility inputs are copied through stable
descriptors into reviewer-owned leaves before analysis, so dashboard links
never point back to mutable producer files.

Bundle review renders every manifest entry regardless of the compatibility
scan limit. Reviewer output must be disjoint from the bundle directory so the
dashboard cannot overwrite the signed manifest or add unlisted files.

## Producer-to-bundle map

| Producer | Canonical output | Bundle source / lane |
| --- | --- | --- |
| Recorded web and native E2E | `e2e-recordings/` | `e2e-recordings` / `e2e` |
| App visual audit | `packages/app/aesthetic-audit-output/` | `aesthetic-audit` |
| Device E2E bundles | `packages/app/device-e2e-output/` | `device-e2e` / `native` |
| App Playwright and native results | `packages/app/test-results/` | `app-test-results` / `e2e` |
| iOS boot captures and device logs | `packages/app/ios/build/{boot-capture,device-logs}/` | `ios-device-capture` / `native` |
| Walkthrough capture | `reports/walkthrough/` | `walkthrough` |
| Live-test artifact wrapper | `reports/live-test-runs/` | `live-test-runs` |
| Scenario runner package commands | `reports/scenarios/` | `scenario-runner` / `scenario` |
| Matrix lane result | temporary `matrix-run.json` | `test-matrix` / `matrix` |

The old compatibility roots `device-e2e-output/`,
`packages/app/reports/walkthrough/`, and
`packages/scenario-runner/reports/` have no live writer. They are excluded from
normal ingestion and remain reviewable only through explicit `--source`.

## App visual crawler

`bun run --cwd packages/app audit:app` is the single maintained app visual
crawler. Its Playwright audit owns the closed view registry, route drift gate,
desktop/mobile capture, rest/hover/error states, and packaged OCR. The normal UI
smoke interaction lane owns semantic control interactions. The unreferenced,
hard-coded `scripts/view-audit/` crawler family was deleted because it duplicated
those contracts, wrote only to `/tmp`, and had no package or workflow entrypoint.

## Deleted-code inventory for #14550

- `scripts/view-audit/cdp-crawler.mjs`
- `scripts/view-audit/deep-crawler.mjs`
- `scripts/view-audit/device-deep-crawler.mjs`
- `scripts/view-audit/device-gentle-crawler.mjs`
- `scripts/view-audit/routes.mjs`
- `scripts/view-audit/run-device-batches.sh`
- `scripts/view-audit/serve-spa.mjs`
- `scripts/view-audit/web-crawler.mjs`
- `scripts/view-audit/web-interactions.mjs`

The evidence reviewer’s implicit 12-directory scan list was also deleted. The
named package ingestors above now define the normal producer inventory.
