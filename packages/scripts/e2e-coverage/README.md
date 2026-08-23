# E2E coverage report

This directory builds a source-derived report of command, route, shortcut,
plugin, and view coverage. `inventory.ts` discovers the live surfaces,
`manifest.ts` records evidence or a documented exemption for report rows, and
`write-coverage-matrix-report.ts` writes JSON and HTML artifacts under
`reports/coverage/`.

The report is diagnostic. It does not compare coverage with historical counts,
grandfather uncovered plugins, or fail a workflow because an inventory changed.

```bash
bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts --report-dir reports/coverage
```
