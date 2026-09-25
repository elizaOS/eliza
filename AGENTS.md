# elizaOS

Monorepo for the Eliza agent runtime, application, cloud services, native
bridges, benchmarks, and first-party plugins. Read the nearest package
`README.md` and `AGENTS.md` before editing; manifests and source are authoritative.

- Preserve unrelated changes in this shared working tree.
- Use pinned Bun 1.4.2 and Node 24.15.0, ESM, and the repository's Biome config.
- Keep core independent of hosts; hosts compose assistant behavior, storage,
  and model providers. Validate untrusted input at boundaries.
- Preserve authorization, tenant isolation, cancellation, and effect receipts.
  Throw typed errors; never fabricate success or hide failures as empty data.
  Use the structured logger and `runtime.reportError` for runtime diagnostics.
- Keep model-facing context and recorded training data complete. Preserve the
  existing authorized source-selection/restoration contract; do not add silent
  truncation, summaries, or recency limits. Reject hard size limits explicitly.
- Use the existing scheduler, entity/relationship stores, and content-addressed
  media store. Do not introduce parallel ownership or bypass SSRF guards.
- Keep READMEs and agent guides short. Retain other Markdown only when consumed
  by runtime, build, tests, publishing, or required attribution. Generated
  reports belong in ignored repository-root `test-results/`, with one leaf per producer.
  Use `packages/scripts/lib/test-output.ts` for stable output paths.
- Verify changed behavior with the owning package's tests, typecheck, and lint,
  then `bun run verify`. Validate documentation links for docs-only changes.
  UI changes require the app visual audit and desktop/mobile inspection.
- Submit changes through a PR against `develop`. Report vulnerabilities
  privately through GitHub Security Advisories. The community plugin registry
  is retired; first-party catalog data lives in `packages/core/src/catalog/`.

Getting started, build, test, and benchmark commands: [README.md](README.md).

Design inventories are advisory; do not gate builds on saved component counts,
story percentages, or expired review metadata.
