# Roadmap

Planned improvements and future work for `@elizaos/core`. Items are grouped by area; order within a section is approximate.

---

## Runtime composition

- **Done:** `loadCharacters`, `getBootstrapSettings`, `mergeSettingsInto`, `createRuntimes`; adapter factory on `Plugin`; plugin-sql, plugin-inmemorydb, and plugin-localdb implement adapter factory; one entry point (telegram example) migrated; composition path does not sync character secrets to `process.env`; unit tests for composition (getBootstrapSettings, mergeSettingsInto, loadCharacters, createRuntimes with adapter override).
- **Possible next steps:**
  - Migrate more entry points (e.g. milaidy) to use composition where it fits. **WHY:** Validates the API and reduces duplicate bootstrap code.
  - Document “bootstrap vs runtime” settings in a single canonical place (e.g. schema or constant list of bootstrap keys) so adapter plugin authors know exactly what they receive. **WHY:** Reduces ambiguity for new plugins (e.g. plugin-mongo).

---

## Plugins and adapters

- **Done:** `Plugin.adapter` is an optional `AdapterFactory`; runtime no longer registers it (handled pre-construction by composition or host). `registerDatabaseAdapter` has been removed; pass the adapter in the `AgentRuntime` constructor. **WHY:** Simplifies the runtime contract.
- **Possible next steps:**
  - If plugin-mongo (or other DB plugins) are added: follow the same pattern (export `plugin` with `adapter(agentId, settings)` using bootstrap settings only). **WHY:** Keeps adapter discovery extensible and consistent.

---

## Testing and quality

- **Done:** Unit tests for runtime composition (`src/__tests__/runtime-composition.test.ts`): getBootstrapSettings (string-only, override order, secrets), mergeSettingsInto (null, no settings, merge order), loadCharacters (empty, object, file path via mock, validation failure), createRuntimes (empty, one character with adapter override, merged character from getAgentsByIds).
- **Possible next steps:**
  - Integration test for `createRuntimes` without adapter override (real plugin-sql resolve) in CI when plugin-sql is available. **WHY:** Full pipeline with real plugin resolution.
  - Run existing plugin-sql and runtime test suites in CI after composition changes. **WHY:** Composition reuses plugin resolution and provisioning; regressions there affect many entry points.

---

## Documentation and DX

- **Done:** [Runtime composition](docs/RUNTIME_COMPOSITION.md) (API, settings divide, examples), WHY-focused comments in `runtime-composition.ts`, README section, CHANGELOG entry, this roadmap.
- **Possible next steps:**
  - Add a short “Quick start with composition” to the main README or docs index (one file path + one code block). **WHY:** Lowers friction for new users who want the recommended path.
  - Cross-link RUNTIME_ARCHITECTURE.md and RUNTIME_COMPOSITION.md (e.g. “for building blocks and bootstrap vs runtime, see Runtime composition”). **WHY:** Helps readers find the right doc.

---

## Other (existing TODO items)

The README “TODO Items” section still lists improvements (e.g. plugin sources, post formatting, server ID issues, ensureConnection refactor). Those remain valid; this roadmap focuses on composition and related areas. As work is done, items can move from “Possible next steps” to “Done” or into CHANGELOG.
