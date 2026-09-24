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
