# elizaos

The `elizaos` CLI: scaffolds elizaOS projects and plugins from packaged templates, upgrades generated projects against newer templates, and submits plugins to the registry. Published to npm as `elizaos`; the `elizaos` bin maps to `dist/cli.js`. Run via `npx elizaos`. Repo-wide rules live in the root [AGENTS.md](../../AGENTS.md).

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
    capability-router.ts  `capabilityRouterConnect` — POST agent API /api/capability-router/connect
    DEPLOY_DESIGN.md   Design notes and follow-up boundaries for the deploy pipeline
    capability-router.test.ts
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

Commands registered on the Commander program: `version`, `info`, `create`, `upgrade`, `deploy`, `plugins submit`, `capability-router connect`. With no subcommand, an interactive `@clack/prompts` menu (`defaultAction`) offers create / upgrade / info / submit-plugin.

## Templates

Two real templates (`templates-manifest.json`): `plugin` and `project`. Each `templates/<id>/template.json` defines `id/name/description/kind/version/languages` plus an optional `aliases` list and an optional `upstream` (git-submodule) block; `getTemplateById` (`manifest.ts`) matches `-t/--template` against either the id or an alias. `min-plugin` / `min-project` are minimal scaffolds (have `SCAFFOLD.md`, no `template.json`) and are not surfaced in the manifest.

Token replacement (`scaffold.ts`): plugin templates substitute `${PLUGINNAME}`, `${PLUGINDESCRIPTION}`, `${GITHUB_USERNAME}`, `${REPO_URL}`, `__ELIZAOS_VERSION__`, and `plugin-starter` variants; project templates substitute `__PROJECT_SLUG__`, `__APP_NAME__`, `__BUNDLE_ID__`, etc. Longest-match-first so prefixes don't clobber.

## Commands

```bash
bun run --cwd packages/elizaos build          # build.ts: prep templates + manifest, tsc, shebang
bun run --cwd packages/elizaos dev            # build.ts --watch
bun run --cwd packages/elizaos typecheck      # tsgo --noEmit
bun run --cwd packages/elizaos test           # vitest run --passWithNoTests
bun run --cwd packages/elizaos test:packaged  # scripts/packaged-smoke.mjs (packs + installs + create/upgrade)
bun run --cwd packages/elizaos lint           # biome check --write (also lints templates/plugin + project/apps/app)
bun run --cwd packages/elizaos lint:check     # biome check (no write)
```

## Config / env vars

- `ELIZAOS_UPSTREAM_REPO` / `ELIZAOS_UPSTREAM_BRANCH` — override a template's `upstream` git-submodule repo/branch in `resolveTemplateUpstream` (`scaffold.ts`). Used by `create` and `upgrade`; the smoke test sets these to point the project template's upstream at the local checkout.
- `capability-router connect` reads `ELIZA_API_BASE_URL` / `ELIZA_API_BASE` (else `http://127.0.0.1:<ELIZA_API_PORT|ELIZA_PORT|2138>`) and `ELIZA_API_TOKEN` for the agent API call.
- `deploy` reads `ELIZAOS_CLOUD_API_KEY`, `ELIZA_CLOUD_API_KEY`, `ELIZACLOUD_API_KEY`, or `~/.elizaos/credentials.json`; `ELIZA_CLOUD_API_BASE_URL` / `ELIZAOS_CLOUD_API_BASE_URL` / `ELIZACLOUD_API_BASE_URL` / `ELIZA_CLOUD_BASE_URL` override the default cloud API base. `ELIZAOS_DEPLOY_POLL_INTERVAL_MS` and `ELIZAOS_DEPLOY_TIMEOUT_MS` override the default status-polling interval and maximum wait time.
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
- `deploy` is experimental: real runs queue `POST /api/v1/apps/:id/deploy`, optionally attach `--domain`, and poll `GET /api/v1/apps/:id/deploy/status` until `READY` or `ERROR`; `--dry-run` prints the planned sequence without network calls.
- This package is intentionally runtime-free — do NOT add `@elizaos/core` or other runtime deps. Keep it to the three production dependencies.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
