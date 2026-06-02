---
title: Plugin Registry Guide
description: How to discover, configure, submit, and maintain plugins in the Eliza plugin registry.
---

# Plugin Registry Guide

The public registry is published at
[`plugins.elizacloud.ai`](https://plugins.elizacloud.ai). Built-in packages are
generated from the elizaOS `plugins/` directory and marked first-party.
Third-party packages are registered by pull request and marked community
supported.

The community registry source of truth now lives **in the monorepo** at
[`packages/registry`](https://github.com/elizaOS/eliza/tree/main/packages/registry).
It replaces the archived, read-only `elizaos-plugins/registry` repository the
old docs pointed at — see
[elizaOS/eliza#8173](https://github.com/elizaOS/eliza/issues/8173).

## Discovering Plugins

The runtime auto-recognizes any npm package whose `keywords` include `elizaos`,
so most plugins are discoverable from npm without a registry entry. The curated
registry adds metadata, categorization, and listing.

The runtime fetches `https://plugins.elizacloud.ai/generated-registry.json` and
falls back to `https://plugins.elizacloud.ai/index.json` if the full registry is
unavailable.

## Using Plugins

Install from the registry or directly with your package manager:

```bash
bun add telegram
bun add @elizaos/plugin-telegram
```

Configure packages in `eliza.json`:

```json
{
  "plugins": ["@elizaos/plugin-telegram", "@elizaos/plugin-openai"]
}
```

## Submitting a Third-Party Package

Publish your package to npm (the `@elizaos/*` scope is reserved — use your own
scope or an unscoped `elizaos-plugin-*` name) and make the GitHub repository
public. Then generate the registry metadata the listing needs:

```bash
elizaos plugins submit . --dry-run
```

This prints the `entries/third-party/<package>.json` file derived from your
`package.json`. To get listed, add that file under
[`packages/registry/entries/third-party/`](https://github.com/elizaOS/eliza/tree/main/packages/registry/entries/third-party),
then validate and regenerate:

```bash
bun run --cwd packages/registry validate
bun run --cwd packages/registry generate
```

Open a pull request with the new entry and the regenerated
`generated-registry.json`. The full step-by-step walkthrough — including a real
worked example
([`packages/examples/plugin-echo`](https://github.com/elizaOS/eliza/tree/main/packages/examples/plugin-echo))
— is in the
[registry package README](https://github.com/elizaOS/eliza/tree/main/packages/registry#adding-a-third-party-plugin).

Third-party packages must not use the reserved `@elizaos/*` scope. Registration
does not make a package first-party supported; community entries are reviewed
for security, functionality, and documentation quality before merge.
