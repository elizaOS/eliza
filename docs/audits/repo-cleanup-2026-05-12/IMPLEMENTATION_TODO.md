# Repo Cleanup Implementation TODO

Date: 2026-05-12

This is the compiled dry-run implementation list from the parallel cleanup
audits in this folder. It does not authorize deletion by itself. Each item
should be implemented only after the owner confirms the candidate is not active
work, runtime input, release evidence, or a generated artifact whose source of
truth is missing.

Source reports:

- `artifacts-markdown-json.md`
- `package-boundaries-shims.md`
- `suppressions-any-fallbacks.md`
- `types-duplication.md`

## Execution Rules

1. Keep all cleanup changes behavior-preserving unless an item explicitly calls
   out an intentional contract correction.
2. Delete files only after `git ls-files`, dependency search, package tests, and
   owner approval prove they are generated, duplicated, or obsolete.
3. Prefer moving public contracts to one owner over re-exporting through shims.
4. Replace suppressions and fallbacks with typed validation at the boundary.
5. Validate every wave with targeted package checks before root validation.
6. End each wave with `bun run lint:check`, `bun run typecheck`, `bun run build`,
   and relevant tests.

## P0 Validation Blockers

### Root validation

- Keep root `bun run lint:check` green.
- Keep root `bun run typecheck` green.
- Keep root `bun run build` green.
- Run root `bun run test` after build completes.
- Rerun lint after build/test because generators and formatters can rewrite
  generated files.

Source: current validation run plus all reports.

### Build export-condition warnings

- Inventory package manifests where `"types"` appears after `"default"` inside
  `exports` conditions.
- Reorder conditions so type resolvers can observe `"types"` before `"default"`.
- Validate with root build and package publish dry-run.

Source: build output, `package-boundaries-shims.md`.

## P1 Type Contract Consolidation

### LifeOps and health connector contracts

- Move shared connector/channel/bus contracts to a package both LifeOps and
  health can import without health internals leaking into LifeOps.
- Replace `plugins/plugin-health/src/connectors/contract-stubs.ts` with imports.
- Replace default-pack contract stubs only if the new owner preserves registry
  contribution semantics.
- Validate with `bun run lint:default-packs`, `bun run --cwd plugins/plugin-health
  typecheck`, `bun run --cwd plugins/app-lifeops typecheck`, and targeted tests.

Source: `types-duplication.md`, `package-boundaries-shims.md`.

### Cloud SDK copy inside plugin-elizacloud

- Make `plugins/plugin-elizacloud` consume `cloud/packages/sdk` directly, or
  generate the plugin-local SDK from the cloud SDK with a sync check.
- Remove hand-maintained duplicate DTOs only after import graph allows it.
- Add a CI guard that detects drift between SDK source and generated copy if a
  generated copy remains.
- Validate cloud SDK, plugin-elizacloud, and cloud API typechecks.

Source: `types-duplication.md`.

### Training route DTOs

- Introduce explicit shared DTOs for app-training inference endpoints and stats.
- Have backend routes and UI API hooks import the same route DTOs.
- Keep UI view models separate if the UI needs transformed names or percentiles.
- Add route tests covering endpoint list and stats payloads.

Source: `types-duplication.md`.

### Skill type ownership

- Keep filesystem/runtime skill shapes in `@elizaos/skills`.
- Rename plugin-agent-skills registry/Otto DTOs so they do not claim the global
  `Skill` name.
- Replace repeated agent `SkillEntry` interfaces with one `SkillListItemDto`.
- Validate package typecheck and agent API route tests.

Source: `types-duplication.md`.

### JSON primitive types

- Import `JsonValue`, `JsonObject`, and `JsonPrimitive` from one owner in
  runtime/plugin code.
- Introduce a deliberately named loose JSON variant where `undefined` is allowed
  before serialization.
- Replace local recursive JSON aliases package by package.

Source: `types-duplication.md`.

### Local inference recommendation types

- Move `RecommendationPlatformClass` and `RecommendedModelSelection` into
  shared local-inference types.
- Replace duplicate app-core and UI declarations with imports.
- Validate app-core and UI typecheck.

Source: `types-duplication.md`.

### Action parameter authoring specs

- Add a core-owned helper type for simplified action parameter authoring.
- Replace cloud bootstrap and MCP schema-converter local `ActionParameter`
  definitions with the shared authoring type.
- Add conversion tests for nested schemas, arrays, enum, default, and required.

Source: `types-duplication.md`.

### Model usage telemetry

- Add a shared `NormalizedModelUsage` and event emission helper.
- Keep provider-specific token extraction local to each provider.
- Update Anthropic and OpenRouter first, then audit other providers.

Source: `types-duplication.md`.

## P1 Suppression and Fallback Hardening

### Streaming route `any`

- Replace `result.fullStream as AsyncIterable<any>` in
  `cloud/apps/api/v1/messages/route.ts` with a discriminated stream-part union
  and normalizer.
- Add tests for text deltas, tool input start/delta/end, unknown part type, and
  missing required fields.

Source: `suppressions-any-fallbacks.md`.

### Pageview JSON parsing

- Stop treating malformed JSON as `{}` in
  `cloud/apps/api/v1/track/pageview/route.ts`.
- Accept only explicit empty/no-body requests as empty.
- Return a typed `400` error for malformed non-empty JSON.
- Test empty body, malformed JSON, body API key, header API key, and invalid app
  id.

Source: `suppressions-any-fallbacks.md`.

### Generated public route clients

- Update public route generators so emitted SDK/router files do not require
  file-wide explicit-any disables.
- Emit `unknown` at raw network boundaries and endpoint-specific DTOs where
  metadata exists.
- Add a generator snapshot or grep guard for new emitted `any`.

Source: `suppressions-any-fallbacks.md`.

### Agent-server config

- Centralize cloud agent-server env validation into one typed config object.
- Inject config into Redis and agent-manager code instead of reading
  `process.env.*!` in lower layers.
- Test missing `REDIS_URL`, `SERVER_NAME`, and
  `AGENT_SERVER_SHARED_SECRET`.

Source: `suppressions-any-fallbacks.md`.

### UI context memo suppressions

- Split `packages/ui/src/state/AppContext.tsx` into smaller context values or
  stable sub-objects so the central memo can be lint-clean.
- Add regression tests for context fields that recently changed.

Source: `suppressions-any-fallbacks.md`.

### Suppression policy guard

- Add a repo guard that fails on new `@ts-ignore`, file-wide `eslint-disable`,
  and unannotated `biome-ignore`.
- Allow documented generated files and targeted test-only `@ts-expect-error`.

Source: `suppressions-any-fallbacks.md`.

## P1 Package Boundary Cleanup

### Source aliases

- Inventory imports that depend on root aliases mapping package subpaths directly
  to `src`.
- Generate test aliases from package `exports` where possible.
- Move legitimate public internals into explicit export subpaths.
- Block new deep source-style imports outside package-local code.

Source: `package-boundaries-shims.md`.

### Wildcard package exports

- Replace `./*` package exports with explicit subpaths package by package.
- Start with `@elizaos/ui` and `@elizaos/shared`, where current consumers are
  identifiable.
- Run `typecheck:dist` and publish dry-run before removing wildcards from
  published packages.

Source: `package-boundaries-shims.md`.

### Agent generated declaration artifacts

- Check whether `packages/agent/src/api/*.d.ts` and `*.d.ts.map` are tracked.
- If tracked and generated, remove them from source and route declarations to
  package `dist`.
- Add ignore coverage or generator output checks so they do not return.

Source: `package-boundaries-shims.md`.

### Plugin SQL package roots

- Normalize `plugins/plugin-sql` to one package root and one export map.
- Validate build, tests, typecheck, and publish dry-run before deleting either
  manifest.

Source: `package-boundaries-shims.md`.

### Compatibility route clusters

- Assign owners and sunset criteria for:
  - `packages/app-core/src/api/*compat-routes.ts`
  - `cloud/apps/api/compat/**`
  - `plugins/app-steward/src/routes/*compat-routes.ts`
  - `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts`
  - `plugins/plugin-elizacloud/src/routes/cloud-compat-routes.ts`
- Remove only after route-client inventory and traffic/consumer proof.

Source: `package-boundaries-shims.md`.

### Shim and stub inventory

- Classify each shim as build-target, test-only, template scaffolding, runtime
  compatibility, or stale migration.
- Only stale migration shims are deletion candidates.
- Keep native plugin web fallbacks unless the browser/desktop build has an
  explicit replacement.

Source: `package-boundaries-shims.md`.

## P1 Artifact and Repo Hygiene

### Reports policy

- Keep curated human-readable release/audit summaries.
- Keep `reports/ai-qa/`, `reports/apps-manual-qa/`, and `reports/porting/`
  ignored as generated run evidence.
- Decide whether timestamped `reports/eliza1-release-gates/*.json` should move
  under ignored generated output or remain canonical release evidence.

Source: `artifacts-markdown-json.md`.

### Training artifacts

- Do not delete `packages/training/data/`, `packages/training/local-corpora/`, or
  generated training reports until regeneration commands, source URLs, checksums,
  and split manifests are documented.
- Keep generated training data out of source control.

Source: `artifacts-markdown-json.md`.

### Benchmark artifacts

- Coordinate with owners before touching dirty benchmark result files.
- Standardize ignores for nested `.venv`, nested `node_modules`, Rust `target`,
  generated `results`, and SWE workspaces.
- Preserve blessed baselines and task fixtures.

Source: `artifacts-markdown-json.md`.

### Mobile/public assets

- Audit compressed assets duplicated across companion public assets and mobile
  package asset folders.
- Do not delete mobile copies until the Capacitor/iOS/Android asset pipeline
  proves they are generated from a single source.

Source: `artifacts-markdown-json.md`.

### Local generated state

- Add or confirm ignores for `.tmp/`, explicit log directories, local DB state,
  benchmark workspaces, and nested virtualenvs.
- Delete local generated state only when no active process depends on it.

Source: `artifacts-markdown-json.md`.

## P2 Knip and Madge

- Run `bun run knip` and record unused exports/files/dependencies.
- Run `bun run knip:strict -- --fail-fast` after low-risk fixes.
- Run Madge circular checks on high-traffic packages first:
  `packages/core/src`, `packages/shared/src`, `packages/ui/src`,
  `packages/app-core/src`, `packages/agent/src`, `plugins/app-lifeops/src`, and
  `plugins/plugin-health/src`.
- Fix true positives by deleting unused code or moving shared types to their
  owner. Suppress only generated files or known build-target shims.

Source: user request plus `package-boundaries-shims.md`.

## P2 Markdown Cleanup

- Keep `README.md` files and generated docs site sources.
- Review prior audit folders for archival consolidation instead of deletion:
  `docs/audits/lifeops-2026-05-09/`,
  `docs/audits/lifeops-2026-05-11/`, and
  `docs/audits/repo-cleanup-2026-05-11/`.
- Review standalone generated HTML under `docs/audits`; prefer source Markdown
  plus ignored rendered HTML if reproducible.
- Keep benchmark/training docs that explain reproducibility, fixtures, or gates.

Source: `artifacts-markdown-json.md`.

## Validation Matrix

Run targeted checks after each package-local implementation:

- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/shared typecheck`
- `bun run --cwd packages/ui typecheck`
- `bun run --cwd packages/app-core typecheck`
- `bun run --cwd packages/agent typecheck`
- `bun run --cwd plugins/app-lifeops typecheck`
- `bun run --cwd plugins/plugin-health typecheck`
- `bun run --cwd plugins/plugin-elizacloud typecheck`
- `bun run --cwd plugins/app-training typecheck`

Run root validation before signoff:

- `bun run lint:check`
- `bun run typecheck`
- `bun run build`
- `bun run test`
- `bun run knip`
- `bun run knip:strict -- --fail-fast`

Run extra validation for boundary/export changes:

- `bun run typecheck:dist`
- `bun run publish:dry-run`
- `bun run audit:package-barrels:check`

Run extra validation for UI changes:

- `bun run test:client`
- `bun run test:ui:playwright`

Run extra validation for server/cloud changes:

- `bun run test:server`
- `bun run --cwd cloud typecheck`
- `bun run --cwd cloud test`
- `bun run --cwd cloud verify`
