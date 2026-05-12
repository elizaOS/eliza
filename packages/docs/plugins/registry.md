---
title: "Plugin Registry"
sidebarTitle: "Registry"
description: "How Eliza discovers first-party and third-party plugins from the registry."
---

The elizaOS plugin registry publishes plugin and app metadata for install,
search, and catalog views. It is available at
[`plugins.elizacloud.ai`](https://plugins.elizacloud.ai).

## Sources

The registry has two explicit package classes:

- **Built-in packages** are generated from the elizaOS monorepo `plugins/`
  directory. They are marked `origin: "builtin"` and
  `support: "first-party"`.
- **Third-party packages** are registered by pull request in
  `entries/third-party/*.json`. They are marked `origin: "third-party"` and
  `support: "community"`.

Third-party registration does not imply first-party elizaOS support.

## Endpoints

| Endpoint | URL | Format |
| --- | --- | --- |
| Primary | `https://plugins.elizacloud.ai/generated-registry.json` | Full registry data, including provenance, npm versions, source directory, compatibility flags, and app metadata |
| Compatibility | `https://plugins.elizacloud.ai/index.json` | Minimal `Record<string, "github:owner/repo">` map |
| Summary | `https://plugins.elizacloud.ai/registry-summary.json` | Compact counts and package list |

The runtime client fetches the primary endpoint first and falls back to the
compatibility endpoint if needed.

For third-party entries, the publishing workflow resolves the latest npm
version during generation, so package releases do not require registry PRs
unless metadata changes.

## Generated Entry Shape

Each package in `generated-registry.json` is keyed by npm package name:

```json
{
  "@elizaos/plugin-openai": {
    "origin": "builtin",
    "support": "first-party",
    "builtIn": true,
    "firstParty": true,
    "thirdParty": false,
    "kind": "plugin",
    "directory": "plugins/plugin-openai",
    "git": {
      "repo": "elizaos/eliza",
      "v2": { "version": "2.0.0-beta.1", "branch": "main" }
    },
    "npm": {
      "repo": "@elizaos/plugin-openai",
      "v2": "2.0.0-beta.1"
    },
    "supports": { "v0": false, "v1": false, "v2": true }
  }
}
```

`directory` is used when a package lives inside a monorepo. This lets fallback
git installs clone the repository but copy/build only the package directory.

## Third-Party Registration

Create one JSON file in the registry repository under `entries/third-party/`:

```json
{
  "package": "@your-scope/plugin-example",
  "repository": "github:your-org/plugin-example",
  "kind": "plugin",
  "description": "Short description shown in the registry.",
  "tags": ["example", "elizaos"]
}
```

The `elizaos` CLI can prepare the metadata and submit the PR from a plugin
project:

```bash
elizaos plugins submit .
```

The command reads `package.json`, validates the npm package and GitHub
repository, writes the third-party metadata file, pushes a branch to your fork
of `elizaos-plugins/registry`, and opens a pull request.

Use `elizaos plugins submit . --dry-run` to inspect the generated metadata
without creating a branch or pull request. Manual submissions add one file under
`entries/third-party/` and must match
`schemas/third-party-package.schema.json`.

## Caching

The agent registry client keeps the same three-tier cache:

1. In-memory cache for the current process.
2. File cache at `~/.eliza/cache/registry.json`.
3. Network fetch from `plugins.elizacloud.ai`.

The cache TTL is one hour. `refreshRegistry()` clears the caches and fetches
fresh data.
