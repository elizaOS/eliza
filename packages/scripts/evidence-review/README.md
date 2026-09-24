# Bundle-first evidence review

The normal evidence path is one integrity-checked bundle.

This directory is part of `.`.

Build from the repository root:

```bash
bun run --cwd . build
```

Test from the repository root:

```bash
bun run --cwd . test
```

Generated evidence uses repository-root `test-results/`: `aesthetic-audit/`,
`device-e2e/`, `app/`, `cloud-e2e/`, and `core/` contain their respective producers.
Keep producer inventories and artifact uploads aligned with these paths.
