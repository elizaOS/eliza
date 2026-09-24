# Bundle-first evidence review

The normal evidence path is one integrity-checked bundle.

These tools run directly from source; no independent build is needed.
Install repository dependencies with `bun install`. Test from the repository root:

```bash
bun run test:scripts
```

Generated evidence uses repository-root `test-results/`: `aesthetic-audit/`,
`device-e2e/`, `app/`, `cloud-e2e/`, and `core/` contain their respective producers.
Keep producer inventories and artifact uploads aligned with these paths.

Use `bun run evidence:review:no-open -- --bundle=<exact-bundle-dir>` to inspect
an existing run without rerunning tests. Generic browsing defaults to no OCR;
`--ocr=on` requires OCR, while `--ocr=auto` records tool unavailability. The
matrix accepts the same choices through `--review-ocr=off|auto|on`. Assertions
in the owning test and required certification evidence are unaffected.
