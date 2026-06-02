# @elizaos/registry

In-repo source of truth for the elizaOS community plugin registry. Replaces the
archived external `elizaos-plugins/registry` repo
([elizaOS/eliza#8173](https://github.com/elizaOS/eliza/issues/8173)). Repo-wide
rules live in the root [AGENTS.md](../../AGENTS.md).

## Role

Holds the third-party (community) plugin registry **data** plus the **tooling**
to validate it and build the wire format the runtime fetches. `private: true` —
it is not published to npm; it is consumed as registry data (over HTTP at
`plugins.elizacloud.ai`) and, optionally, as a typed loader via `workspace:*`.

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
```

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
