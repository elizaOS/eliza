# `@elizaos/registry`

Source of truth for the elizaOS community plugin registry and the curated
first-party catalog. This guide adds package-specific rules to the root
[CLAUDE.md](../../CLAUDE.md); the root guide remains binding.

## Role

Two registries live here, exported under separate subpaths — **do not conflate
their schemas** (they model different things):

- **`.` (community / third-party)** — the third-party plugin registry **data**
  plus the **tooling** to validate it and build the wire format the runtime
  fetches. Consumed as registry data (over HTTP at `plugins.eliza.app`) and,
  optionally, as a typed loader via `workspace:*`. Its validation is
  deliberately hand-written so the published JSON Schema and runtime wire
  contract remain explicit.
- **`./first-party` (curated, in-repo)** — the first-party curated registry of
  bundled apps / plugins / connectors (moved here from `@elizaos/app-core`). Rich
  Zod schema with `config` fields, `render` hints, `launch.routePlugin`, and
  connector `accounts`. Exposes `loadRegistry()` + typed accessors and a
  plugin-side `registerRegistryEntry()` runtime overlay. Re-exported by
  `@elizaos/app-core/registry` for backwards compatibility.

The public npm package ships `src/` as TypeScript, including the generated
first-party JSON. Published workspace consumers depend on it, so it must remain
public and verify its packed dependency graph before release.

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
bun run --cwd packages/registry lint:check
bun run --cwd packages/registry format:check
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
- `zod` supports the first-party catalog. Do not make community-registry
  validation depend on first-party catalog types or schemas.

## Verification

Run `validate`, `generate`, `generate:first-party:check`, `test`, and
`typecheck`. Inspect both generated JSON diffs rather than accepting generation
as proof by itself. Changes to schemas or loaders also need an end-to-end check
through the consuming registry client or app catalog, including malformed,
reserved-scope, and incompatible entries. Follow the root evidence standard and
attach the generated artifacts and observable failure output relevant to the
change.
