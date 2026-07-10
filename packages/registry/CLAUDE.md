# @elizaos/registry

In-repo source of truth for the elizaOS community plugin registry. Replaces the
archived external `elizaos-plugins/registry` repo
([elizaOS/eliza#8173](https://github.com/elizaOS/eliza/issues/8173)). Repo-wide
rules live in the root [AGENTS.md](../../AGENTS.md).

## Role

Two registries live here, exported under separate subpaths — **do not conflate
their schemas** (they model different things):

- **`.` (community / third-party)** — the third-party plugin registry **data**
  plus the **tooling** to validate it and build the wire format the runtime
  fetches. Consumed as registry data (over HTTP at `plugins.elizacloud.ai`) and,
  optionally, as a typed loader via `workspace:*`. Dependency-free, hand-rolled
  validation.
- **`./first-party` (curated, in-repo)** — the first-party curated registry of
  bundled apps / plugins / connectors (moved here from `@elizaos/app-core`). Rich
  Zod schema with `config` fields, `render` hints, `launch.routePlugin`, and
  connector `accounts`. Exposes `loadRegistry()` + typed accessors and a
  plugin-side `registerRegistryEntry()` runtime overlay. Re-exported by
  `@elizaos/app-core/registry` for backwards compatibility.

Published to npm (`@elizaos/registry`, `publishConfig.access: public`). It ships
its `src/` as raw TypeScript — same publish-as-source convention as
`@elizaos/prompts` — with `files: ["src"]` so the first-party JSON under
`src/first-party/` travels with it. It was un-privatized in #15833: published
`@elizaos/shared` / `@elizaos/agent` / `@elizaos/app-core` pin it via
`workspace:*`, so while it was `private: true` the rewritten pin 404'd for every
external `npm install` of the beta line. `packages/scripts/publish-graph-guard.mjs`
guards that invariant for the whole workspace going forward.

## Layout

```
entries/third-party/*.json   one source entry per community package (SoT)
schema/registry-entry.schema.json   JSON Schema mirroring src/schema.ts
generated-registry.json      built wire format ({ registry: { "<pkg>": {…} } })
src/
  types.ts        RegistryEntry (source) + GeneratedRegistry (wire) types
  schema.ts       validateRegistryEntry / assertRegistryEntry (dependency-free)
  loader.ts       loadThirdPartyEntries — read + validate entries/third-party
  generate.ts     generateRegistry / toGeneratedEntry — entries → wire format
  validate-cli.ts `bun run validate`
  index.ts        public barrel (typed loader for programmatic consumers)
  first-party/    @elizaos/registry/first-party — curated bundled registry
    schema.ts     Zod entry schemas (app / plugin / connector)
    loader.ts     loadRegistryFromRawEntries / indexEntries / typed accessors
    index.ts      loadRegistry() (reads generated.json) + registerRegistryEntry()
    app-registry.ts  registerCuratedApp curated-app name store
    generate.ts   aggregator: plugin-owned + curated/ -> generated.json
    generated.json   built aggregate the runtime reads (one file; commit it)
    curated/{apps,plugins,connectors}/*.json   entries with no vendored package
```

## First-party registration is plugin-side

Each in-repo plugin/package **owns its registry entry** as a `registry-entry.json`
in its own directory (a single entry object, or an array). Curated entries with
no vendored package — built-in app-viewers and entries for plugins not checked
out here — live under `first-party/curated/`. The aggregator gathers both into a
single committed `generated.json` that the runtime reads, so on-device staging is
one file. Plugins may also contribute or override an entry **at runtime** via
`registerRegistryEntry()` (deduped by `id`; runtime entries win).

```bash
bun run --cwd packages/registry generate:first-party         # rewrite generated.json
bun run --cwd packages/registry generate:first-party:check   # CI drift gate
```

- **Add/change a first-party entry:** edit the plugin's `registry-entry.json`
  (or a file under `first-party/curated/`), then `generate:first-party` and
  commit the regenerated `generated.json`.

## Two formats — don't conflate

- **Source entry** (`entries/third-party/*.json`): the human/CLI-authored
  per-package metadata. Matches `elizaos plugins submit --dry-run` output and
  the `ThirdPartyMetadata` shape in `packages/elizaos/src/commands/plugins.ts`.
- **Generated wire registry** (`generated-registry.json`): produced from the
  source entries; matches the parser in
  `packages/agent/src/services/registry-client-network.ts`. Never hand-edit;
  always `bun run generate`.

## Commands

```bash
bun run --cwd packages/registry validate   # exits non-zero on a malformed entry
bun run --cwd packages/registry generate   # regenerate generated-registry.json
bun run --cwd packages/registry test       # vitest
bun run --cwd packages/registry typecheck
```

## How to extend

- **List a plugin:** add `entries/third-party/<package>.json` (see
  `README.md` → "Adding a third-party plugin"), then `validate` + `generate` and
  commit the regenerated `generated-registry.json` alongside the entry.
- **Change the entry shape:** update `src/types.ts`, `src/schema.ts`, AND
  `schema/registry-entry.schema.json` together so the code and the published
  JSON Schema stay in lockstep.

## Conventions / gotchas

- The `@elizaos/*` scope is reserved for first-party packages — the validator
  rejects it in source entries.
- `generate.ts` and `validate-cli.ts` are run with `bun` (TypeScript directly);
  there is no `dist` build step beyond regenerating the JSON.
- Keep the package dependency-free (validation is hand-rolled) so the tooling
  runs in any CI context without install ordering concerns.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — runtime / framework:**
- A **live-LLM** scenario trajectory for the runtime path you touched — provider → model → action → evaluator — with the raw `<response>` XML and every tool/action call visible and **read**.
- Backend `[ClassName]` logs proving the message loop, task scheduler, or service actually fired end to end.
- The memory/state artifacts produced — rows written, embeddings, room/world/entity records, scheduled-task rows — inspected, not assumed.
- For shared modules: `build:node` vs full `build` so the browser/edge bundles still compile.
<!-- END: evidence-and-e2e-mandate -->
