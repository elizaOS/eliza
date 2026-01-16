# Documentation Scripts

Place documentation generation scripts here (Bun/TypeScript scripts that pull upstream docs).

The root `package.json` exposes a `docs:generate` script you can run with:

```bash
bun run docs:generate
```

This runs the orchestrator `scripts/docs/generate_all_docs.ts`, which:
- Scans `scripts/docs` for files named `pull_<vendor>_docs.ts`
- Runs each of them in parallel as:
  `bun scripts/docs/pull_<vendor>_docs.ts --output docs/vendors/<vendor>`

To add a new vendor, just drop a `pull_<vendor>_docs.ts` script here following that convention. No need to change `package.json`.
