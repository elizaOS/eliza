# `elizaos`

The package-first elizaOS CLI. It scaffolds and upgrades projects/plugins,
submits plugin metadata, deploys Eliza Cloud apps, connects capability-router
endpoints, and migrates supported file-based agent workspaces. It is published
as `elizaos`; the `elizaos` bin maps to `dist/cli.js`.

Repository-wide engineering and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Role

A standalone, dependency-light CLI (only `@clack/prompts`, `commander`, `picocolors`). It does NOT import the elizaOS runtime — it renders template trees, writes `.elizaos/template.json` metadata, and shells out to `git`/`gh`/`npm`. The library entry (`src/index.ts`) re-exports the command functions and `loadManifest` so other tooling can call them programmatically; the CLI entry (`src/cli.ts`) wires them to Commander.

## Layout

```
src/
  cli.ts               #!/usr/bin/env node — Commander program; default action = interactive @clack menu
  index.ts             Library exports (create, info, upgrade, version, registerPluginsCommand, submitPluginToRegistry, loadManifest, types)
  commands/
    index.ts           Barrel re-exporting every command function
    create.ts          `create` — prompt template/lang/name, render tree, init upstream submodule, write metadata
    upgrade.ts         `upgrade` — re-render template into temp dir, diff via managed-file hashes, apply
    info.ts            `info` — list templates (text or --json)
    version.ts         `version` — print CLI version from package.json
    plugins.ts         `registerPluginsCommand` + `submitPluginToRegistry` — generate registry metadata and open an explicit registry PR via git/gh
    deploy.ts          `deploy` / `runDeploy` — Eliza Cloud app deploy trigger + status polling (`--dry-run` prints plan only)
    migrate-agent.ts   `migrate-agent` — import supported OCPlatform file agents into an Eliza archive
    capability-router.ts  `capabilityRouterConnect` — POST agent API /api/capability-router/connect
    DEPLOY_DESIGN.md   Design notes and follow-up boundaries for the deploy pipeline
    capability-router.test.ts
  migrate/             archive writer, OCPlatform reader, character mapping, memory tiering, schemas, tests
  scaffold.ts          Core engine: template-value builders, ${...} token replacement, renderTemplateTree,
                       managed-file diff (updateManagedFiles), git submodule init/update/hydrate
  manifest.ts          loadManifest / getTemplateById / getTemplates / TEMPLATE_ICONS (reads templates-manifest.json)
  project-metadata.ts  read/write .elizaos/template.json (ProjectTemplateMetadata)
  package-info.ts      getPackageRoot / readPackageJson / getCliVersion
  types.ts             All shared types/DTOs (TemplateDefinition, *TemplateValues, *Options, metadata)
  __tests__/safe-copy-dir.test.ts
build.ts               Build: copies templates, regenerates templates-manifest.json, runs tsc, sets cli.js shebang
safe-copy-dir.ts       Path-contained recursive copyDir used by build.ts
scripts/packaged-smoke.mjs   npm-pack + global/local install + create/upgrade end-to-end smoke (test:packaged)
templates/             Shipped template trees (plugin, project, min-plugin, min-project), each with template.json
templates-manifest.json  Generated index of templates (loaded at runtime by manifest.ts)
```

## Key exports

`src/index.ts` re-exports: `create`, `info`, `upgrade`, `version`, `registerPluginsCommand`, `submitPluginToRegistry`, `loadManifest`, and types `TemplateDefinition` / `TemplatesManifest`. `src/cli.ts` additionally uses `deploy` and `capabilityRouterConnect` from `commands/index.ts`.

Commands registered on the Commander program: `version`, `info`, `create`,
`upgrade`, `deploy`, `migrate-agent`, `plugins submit`, and
`capability-router connect`. With no subcommand, an interactive
`@clack/prompts` menu offers create, upgrade, info, and plugin submission.

## Templates

Two real templates (`templates-manifest.json`): `plugin` and `project`. Each `templates/<id>/template.json` defines `id/name/description/kind/version/languages` plus an optional `aliases` list and an optional `upstream` (git-submodule) block; `getTemplateById` (`manifest.ts`) matches `-t/--template` against either the id or an alias. `min-plugin` / `min-project` are minimal scaffolds (have `SCAFFOLD.md`, no `template.json`) and are not surfaced in the manifest.

Token replacement (`scaffold.ts`): plugin templates substitute `${PLUGINNAME}`, `${PLUGINDESCRIPTION}`, `${GITHUB_USERNAME}`, `${REPO_URL}`, `__ELIZAOS_VERSION__`, and `plugin-starter` variants; project templates substitute `__PROJECT_SLUG__`, `__APP_NAME__`, `__BUNDLE_ID__`, etc. Longest-match-first so prefixes don't clobber.

## Commands

```bash
bun run --cwd packages/elizaos build          # build.ts: prep templates + manifest, tsc, shebang
bun run --cwd packages/elizaos dev            # build.ts --watch
bun run --cwd packages/elizaos typecheck      # tsc --noEmit
bun run --cwd packages/elizaos test           # vitest run --passWithNoTests
bun run --cwd packages/elizaos test:packaged  # scripts/packaged-smoke.mjs (packs + installs + create/upgrade)
bun run --cwd packages/elizaos lint           # biome check --write (also lints templates/plugin + project/apps/app)
bun run --cwd packages/elizaos lint:check     # biome check (no write)
```

## Config / env vars

- `ELIZAOS_UPSTREAM_REPO` / `ELIZAOS_UPSTREAM_BRANCH` — override a template's `upstream` git-submodule repo/branch in `resolveTemplateUpstream` (`scaffold.ts`). Used by `create` and `upgrade`; the smoke test sets these to point the project template's upstream at the local checkout.
- `capability-router connect` reads `ELIZA_API_BASE_URL` / `ELIZA_API_BASE` (else `http://127.0.0.1:<ELIZA_API_PORT|ELIZA_PORT|2138>`) and `ELIZA_API_TOKEN` for the agent API call.
- `deploy` reads `ELIZAOS_CLOUD_API_KEY`, `ELIZA_CLOUD_API_KEY`, `ELIZACLOUD_API_KEY`, or `~/.elizaos/credentials.json`; `ELIZA_CLOUD_API_BASE_URL` / `ELIZAOS_CLOUD_API_BASE_URL` / `ELIZACLOUD_API_BASE_URL` / `ELIZA_CLOUD_BASE_URL` override the default cloud API base. `ELIZAOS_DEPLOY_POLL_INTERVAL_MS` (default 5000) overrides the default status-polling interval; `ELIZAOS_DEPLOY_TIMEOUT_MS` (default 600000) overrides the maximum wait time. `ELIZAOS_DEPLOY_POLL_INTERVAL_MS` accepts any `Number()`-compatible integer spelling (leading zeros, exponent notation, surrounding whitespace, and non-decimal forms like `0x`/`0b`/`0o`) from 0 through 2147483647; unset or blank keeps the default, `0` polls with no delay between checks, and a fractional, negative, non-numeric, or out-of-range value throws before any network call. `pollDeploymentStatus` bounds each sleep by the remaining `ELIZAOS_DEPLOY_TIMEOUT_MS` budget, not the raw configured interval — an interval larger than the timeout (the accepted range runs up to node's ~24.8-day max timer delay) still exits at the documented timeout instead of stalling past it.
- `packaged-smoke.mjs` honors `ELIZAOS_SMOKE_*` flags (`KEEP_TEMP`, `EJECT`, `REMOTE_UPSTREAM`, `SKIP_GLOBAL_INSTALL`, `FULLSTACK_INSTALL`, `TMPDIR`).

Generated projects record state in `.elizaos/template.json` (`ProjectTemplateMetadata`): `cliVersion`, `templateId`, `templateVersion`, `values`, and a `managedFiles` map of relative-path → sha256. `upgrade` uses these hashes to classify each file as updated / created / deleted / unchanged / conflict; locally-modified files become conflicts and are left untouched.

## How to extend

- **Add a template:** create `templates/<id>/` with a `template.json` (matching `TemplateDefinition`), use the token placeholders above in files/filenames, and run `build` to regenerate `templates-manifest.json`. If the template needs an upstream checkout, add the `upstream` block and the matching value builder in `scaffold.ts` (`buildPluginTemplateValues` / `buildFullstackTemplateValues`) plus its key list (`PLUGIN_TEMPLATE_VALUE_KEYS` / `FULLSTACK_TEMPLATE_VALUE_KEYS`).
- **Add a command:** implement it under `src/commands/<name>.ts`, export from `src/commands/index.ts`, register it on the program in `src/cli.ts`, and (if it should be callable as a library) re-export from `src/index.ts`. Define its options interface in `src/types.ts`.

## Conventions / gotchas

- `manifest.ts` and `getTemplatesDir` read `templates-manifest.json` and `templates/` relative to `getPackageRoot()` (one dir up from `dist/`), so the CLI only works after `build` and against the shipped `dist` + `templates` (both in the `files` allowlist). `loadManifest` throws if the manifest is missing — run `build` first.
- `cli.ts` ends with top-level `await program.parseAsync()`; the bin shebang is `#!/usr/bin/env node` (re-applied by `ensureCliShebang` in `build.ts`).
- Commands that interact with the user use `@clack/prompts` and call `process.exit(...)` directly on cancel/error; `deploy`/`capabilityRouterConnect` split a pure `run*` function (returns exit code) from the thin `process.exit` wrapper for testability.
- `plugins submit --dry-run` prints the generated `entries/third-party/<pkg>.json` metadata. Opening a PR requires an explicit `--registry owner/repo`; no public default registry repository is configured. `@elizaos/*` names are rejected (reserved for first-party).
- `deploy` queues `POST /api/v1/apps/:id/deploy`, optionally attaches
  `--domain`, and polls `GET /api/v1/apps/:id/deploy/status` until `READY` or
  `ERROR`; `--dry-run` prints the plan without network calls.
- The `AGENTS.md` files below `src/migrate/__tests__/fixtures/` are input data.
  Do not copy a `CLAUDE.md` beside them or rewrite them as package guidance;
  preserve their fixture semantics unless the migration contract changes.
- This package is intentionally runtime-free — do NOT add `@elizaos/core` or other runtime deps. Keep it to the three production dependencies.

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For CLI
changes, additionally run the built and packed CLI—not only source helpers—and
capture arguments, stdout/stderr, exit status, and generated files. Exercise
invalid arguments, missing dependencies, partial/conflicting state, and
permission/network failures relevant to the command. Template changes require
the packaged create/upgrade smoke and inspection of the generated workspace.
