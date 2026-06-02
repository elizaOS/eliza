# @elizaos/registry

In-repo source of truth for the elizaOS **community plugin registry**.

This package replaces the archived, read-only `elizaos-plugins/registry` GitHub
repository that the publish docs used to point at (see
[elizaOS/eliza#8173](https://github.com/elizaOS/eliza/issues/8173)). Third-party
plugins are now listed by adding one JSON file here and opening a pull request
against this monorepo.

## What's in here

```
packages/registry/
├── entries/third-party/        one <package>.json per community package (source of truth)
├── schema/registry-entry.schema.json   JSON Schema for an entry
├── generated-registry.json     wire format the runtime fetches (built from entries/)
└── src/
    ├── types.ts                RegistryEntry + GeneratedRegistry types
    ├── schema.ts               dependency-free entry validation
    ├── loader.ts               read + validate entries/third-party/*.json
    ├── generate.ts             entries → generated-registry.json
    ├── validate-cli.ts         `bun run validate`
    └── index.ts                typed loader for programmatic consumers
```

Two formats live here:

1. **Source entry** (`entries/third-party/*.json`) — what contributors and
   `elizaos plugins submit --dry-run` author. One file per package.
2. **Generated wire registry** (`generated-registry.json`) — the
   `{ registry: { "<package>": { … } } }` shape the runtime consumes from
   `plugins.elizacloud.ai/generated-registry.json`. Produced by `generate.ts`;
   never hand-edited.

## Commands

```bash
bun run --cwd packages/registry validate    # validate every entry against the schema
bun run --cwd packages/registry generate    # regenerate generated-registry.json
bun run --cwd packages/registry test        # unit tests
bun run --cwd packages/registry typecheck
```

## Adding a third-party plugin

The runtime auto-discovers any npm package whose `keywords` include `elizaos`,
so a listing here is for **discoverability and curation**, not a hard
requirement to run a plugin. To get listed:

1. **Publish your plugin to npm** under your own scope or an unscoped
   `elizaos-plugin-*` name. The `@elizaos/*` scope is reserved for first-party
   packages and is rejected by the validator.

2. **Generate the entry metadata** from your plugin project:

   ```bash
   elizaos plugins submit . --dry-run
   ```

   This prints the `entries/third-party/<package>.json` the CLI derives from
   your `package.json` (name, repository, kind, description, tags).

3. **Add the file** under `entries/third-party/`, named after the package
   (`/` → `__`, `@` dropped). For `elizaos-plugin-echo`:

   ```json
   {
     "package": "elizaos-plugin-echo",
     "repository": "github:elizaOS/eliza",
     "kind": "plugin",
     "description": "Reference third-party elizaOS plugin: an ECHO action that repeats a message back.",
     "homepage": "https://github.com/elizaOS/eliza/tree/main/packages/examples/plugin-echo",
     "version": "2.0.0-beta.0",
     "directory": "packages/examples/plugin-echo",
     "tags": ["example", "utility", "reference"]
   }
   ```

   Required: `package`, `repository`, `kind` (`plugin` · `connector` · `app`).
   Optional: `description`, `homepage`, `version`, `directory`, `tags`.

4. **Validate and regenerate:**

   ```bash
   bun run --cwd packages/registry validate
   bun run --cwd packages/registry generate
   ```

5. **Open a pull request** with the new entry file and the regenerated
   `generated-registry.json`. Community entries are reviewed for security,
   functionality, and documentation quality before merge.

## Worked example

[`packages/examples/plugin-echo`](../examples/plugin-echo) is a real, buildable
third-party plugin (a single `ECHO` action) listed via
[`entries/third-party/elizaos-plugin-echo.json`](entries/third-party/elizaos-plugin-echo.json).
Use it as the template for your own listing.
