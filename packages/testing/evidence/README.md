# @elizaos/testing/evidence

Evidence-bundle, analysis, visual-QA, GPU-queue, video, and certification foundation for the repository evidence harness.

Verify the exact finalized evidence bundle and its artifact hashes. Preserve the pre-run inventory and producer provenance; never infer a coordinated run by recency.

This directory is part of `packages/testing`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/testing test
```

Generated evidence uses repository-root `test-results/`: `aesthetic-audit/`,
`device-e2e/`, `app/`, `cloud-e2e/`, and `core/` contain their respective producers.
Keep producer inventories and artifact uploads aligned with these paths.

## Choose the work you need

- Capture and hash: `bundle:snapshot` before the owning tests, then
  `bundle:create -- --tier cpu --baseline <snapshot> --json` and
  `bundle:verify -- <exact-bundle-dir>`. This performs no model review.
- Browse: from the repository root, run `bun run evidence:review:no-open --
  --bundle=<exact-bundle-dir>`. OCR is off by default; use `--ocr=on` only when
  needed. Existing test assertions and required evidence remain authoritative.
- Interpret: inspect the bundle's original screenshots, logs, traces and receipts
  in your current ChatGPT/Codex/Claude session. Record the reviewer and supporting
  artifact paths; conversational conclusions do not replace execution evidence.
- Automate selected visual questions with `vision-qa`, using an explicitly chosen
  API/local/CLI backend. Calls consume provider or CLI usage. Exact duplicate
  requests within a batch share work; each artifact still receives its result.
- Sign when required: `certify` runs the matrix, snapshots producer inputs and
  signs the verified result. Model-based review requires `--vision-qa`, even if
  credentials exist. `--skip-matrix` explicitly adopts existing producer outputs;
  it does not prove a fresh run. `--bundle <dir>` certifies an existing finalized
  bundle without rerunning capture or interpretation.

CPU/GPU/full describe execution capability, not coverage or quality. Missing
required evidence and skipped test lanes retain their existing failure rules.
Review in a current assistant session requires neither a GPU worker nor a new
paid model subprocess for each screenshot. Keep complete raw trajectories and
real effect receipts regardless of how you review them.
