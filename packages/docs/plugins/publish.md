---
title: "Publish a Plugin"
sidebarTitle: "Publish"
description: "How to package, version, and publish a Eliza plugin to the npm registry and submit it to the community registry."
---

This guide covers the full publishing workflow for a Eliza plugin — from packaging to npm publication and community registry submission.

## Naming Conventions

Choose a package name that follows the established convention:

| Scope | Pattern | Example |
|-------|---------|---------|
| Official elizaOS | `@elizaos/plugin-{name}` | `@elizaos/plugin-openai` |
| Community (scoped) | `@yourorg/plugin-{name}` | `@acme/plugin-analytics` |
| Community (unscoped) | `elizaos-plugin-{name}` | `elizaos-plugin-weather` |

The runtime recognizes all three patterns for auto-discovery.

## package.json Requirements

Your plugin's `package.json` must include these fields:

```json
{
  "name": "@elizaos/plugin-my-feature",
  "version": "1.0.0",
  "description": "One-line description of what this plugin does",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "elizaos.plugin.json"],
  "keywords": ["elizaos", "eliza", "plugin"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourorg/plugin-my-feature"
  },
  "peerDependencies": {
    "@elizaos/core": ">=2.0.0-alpha"
  },
  "devDependencies": {
    "@elizaos/core": "alpha",
    "typescript": "^5.0.0"
  }
}
```

**Key points:**
- Declare `@elizaos/core` as a `peerDependency` — not a direct dependency — to avoid version conflicts.
- Include `elizaos.plugin.json` in `files` so the manifest is published alongside the code.
- Use `"type": "module"` for ESM output.

## Build Configuration

Use TypeScript targeting ESM:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

## Versioning

Follow [Semantic Versioning](https://semver.org/):

| Change | Bump |
|--------|------|
| New action, provider, or feature (backward compatible) | Minor (`1.0.0` → `1.1.0`) |
| Bug fixes only | Patch (`1.0.0` → `1.0.1`) |
| Breaking API change | Major (`1.0.0` → `2.0.0`) |

For plugins targeting the elizaOS `next` release line, use prerelease versions:

```bash
npm version prerelease --preid=next
# 1.0.0 → 1.0.1-next.0
```

## Publishing to npm

### 1. Authenticate

```bash
npm login
```

### 2. Build

```bash
bun run build
```

Verify the `dist/` directory contains the compiled output before publishing.

### 3. Dry Run

Always preview what will be published:

```bash
npm publish --dry-run --access public
```

Check that the output includes only `dist/`, `elizaos.plugin.json`, `package.json`, and `README.md`.

### 4. Publish

```bash
npm publish --access public
```

For prerelease versions targeting the elizaOS `next` release line:

```bash
npm publish --access public --tag next
```

### 5. Verify

```bash
npm info @yourorg/plugin-my-feature
```

## Plugin Manifest

Include an `elizaos.plugin.json` at the package root for rich UI integration in the Eliza admin panel:

```json
{
  "id": "my-feature",
  "name": "My Feature Plugin",
  "description": "Does something useful",
  "version": "1.0.0",
  "kind": "skill",

  "requiredSecrets": ["MY_FEATURE_API_KEY"],
  "optionalSecrets": ["MY_FEATURE_DEBUG"],

  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "endpoint": { "type": "string", "format": "uri" }
    },
    "required": ["apiKey"]
  },

  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "sensitive": true
    }
  }
}
```

## Best Practices

**Documentation:**
- Include a `README.md` with installation instructions, required environment variables, and usage examples.
- Document every action with a description of when the LLM will invoke it.
- List all required and optional env vars in a table.

**Security:**
- Never log API keys or secrets — use `runtime.logger` carefully.
- Validate and sanitize all parameters in action handlers.
- Use `peerDependencies` for `@elizaos/core` to prevent duplicate installations.

**Compatibility:**
- Test against the current `next` release of `@elizaos/core`.
- Declare your `peerDependencies` version range conservatively: `"@elizaos/core": ">=2.0.0-alpha"`.
- Export a `Plugin` type-compatible default export — do not use default exports for other purposes.

**Quality:**
- Include unit tests with at least 80% coverage. (Note: this is the recommended bar for standalone published plugins. The monorepo enforces a 25% lines/functions/statements, 15% branches floor from `scripts/coverage-policy.mjs`.)
- Run `tsc --noEmit` in CI to catch type errors.
- Test the published package with `npm pack` before publishing.

## Multi-Language Plugins

Plugins can include implementations in multiple languages:

```
my-plugin/
├── typescript/     # Primary TypeScript implementation
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── python/         # Optional Python SDK bindings
│   ├── src/
│   └── pyproject.toml
├── rust/           # Optional Rust native module
│   ├── src/
│   └── Cargo.toml
└── elizaos.plugin.json
```

The TypeScript implementation is always required. Python and Rust implementations are optional and used by their respective SDKs. The `elizaos.plugin.json` manifest at the root describes the plugin for all languages.

## Community Registry

After publishing to npm, submit your plugin to the community registry by opening a PR to [`elizaos-plugins/registry`](https://github.com/elizaos-plugins/registry).

Include in your PR:
1. Entry in `index.json` mapping your package name to its git repo
2. A working `elizaos.plugin.json` manifest in your package
3. At least one passing test suite
4. README with setup instructions and required environment variables

Community plugins are reviewed for security, functionality, and documentation quality before listing. See [Registry Documentation](./registry#submitting-a-plugin-to-the-registry) for details.

## Related

- [Plugin Schemas](/plugins/schemas) — Full schema reference
- [Create a Plugin](/plugins/create-a-plugin) — Build a plugin from scratch
- [Plugin Registry](/plugins/registry) — Browse published plugins
