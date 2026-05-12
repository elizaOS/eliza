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

## Discovering Plugins

```bash
eliza plugins list
eliza plugins list --search telegram
eliza plugins info telegram
```

The runtime fetches `https://plugins.elizacloud.ai/generated-registry.json` and
falls back to `https://plugins.elizacloud.ai/index.json` if the full registry is
unavailable.

## Using Plugins

Install from the registry or directly with your package manager:

```bash
eliza plugins install telegram
bun add @elizaos/plugin-telegram
```

Configure packages in `eliza.json`:

```json
{
  "plugins": ["@elizaos/plugin-telegram", "@elizaos/plugin-openai"]
}
```

## Submitting a Third-Party Package

Publish your package to npm, make sure the GitHub repository is public, then run
from the plugin project:

```bash
elizaos plugins submit .
```

The CLI opens a pull request adding one JSON metadata file to
`entries/third-party/` in `elizaos-plugins/registry`.

Third-party packages must not use the reserved `@elizaos/*` scope. Registration
does not make a package first-party supported.

For a manual submission, fork `elizaos-plugins/registry`, add one schema-valid
JSON file under `entries/third-party/`, run `npm run validate`, and open a pull
request.
