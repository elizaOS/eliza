---
title: Publish a plugin
description: Build an ESM plugin package, publish it to npm, and optionally submit it to the elizaOS registry.
---

An elizaOS plugin is an ESM npm package whose default export is a `Plugin`.
Start from the [current plugin template](/plugins/create-a-plugin), which already
contains the supported build, exports, files list, and publication metadata.

## Package requirements

Use your own npm scope or an unscoped `elizaos-plugin-*` name. The `@elizaos/*`
scope is reserved for first-party packages.

The generated package includes these important fields:

```json
{
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "packageType": "plugin",
  "exports": {
    "./package.json": "./package.json",
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    }
  },
  "files": ["dist", "README.md", ".npmignore", ".gitignore", "package.json"],
  "keywords": ["plugin", "elizaos"],
  "publishConfig": { "access": "public" }
}
```

Keep the generated `@elizaos/core` dependency aligned with the runtime release
you support. Do not advertise a compatibility range that you have not tested.
Declare public settings in `agentConfig.pluginParameters` so installation
surfaces can explain them without embedding secret values.

## Verify the package

```bash
bun run build
bun run typecheck
bun run lint:check
bun run test
npm publish --dry-run --access public
```

Inspect the dry-run file list. Runtime source, fixtures, credentials, local
state, and unpublished frontend artifacts should not appear in the tarball.
Test the packed artifact from a clean host project when resolution behavior or
exports changed.

## Publish to npm

```bash
npm login
npm publish --access public
```

Use an npm dist-tag for a prerelease instead of moving `latest`:

```bash
npm publish --access public --tag beta
```

After publication, verify the public metadata and install the published version
in a clean project:

```bash
npm info @yourorg/plugin-my-feature
```

Any reachable npm package with the `elizaos` keyword can be recognized as a
plugin. A curated registry entry improves discovery but is not required for
runtime loading.

## Submit to the community registry

Generate the proposed entry from the published plugin project:

```bash
elizaos plugins submit . --dry-run
```

Add the resulting JSON under `packages/registry/entries/third-party/` in this
monorepo, then validate and regenerate the wire registry:

```bash
bun run --cwd packages/registry validate
bun run --cwd packages/registry generate
```

Open a pull request containing the source entry and regenerated registry. The
exact entry schema and filename convention are documented in the
[`packages/registry` README](https://github.com/elizaOS/eliza/tree/develop/packages/registry).

## Release checklist

- The package name, repository, license, description, and keywords are correct.
- `src/index.ts` exports the plugin as both named and default.
- Build, typecheck, lint, component tests, and real-runtime E2E pass.
- Required settings and permissions are documented without exposing secrets.
- The npm dry run contains only intentional release files.
- The published package installs and loads in a clean agent project.

## Related

- [Create a plugin](/plugins/create-a-plugin)
- [Testing plugins](/plugins/testing)
- [Local plugin resolution](/plugins/local-plugins)
- [Registry guide](/tracks/plugin/publish)
