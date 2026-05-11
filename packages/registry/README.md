# elizaOS Plugin Registry

This repository publishes the elizaOS plugin registry as both JSON data and a
web catalog at [plugins.elizacloud.ai](https://plugins.elizacloud.ai).

The registry has two sources:

- **Built-in packages** are generated from the elizaOS monorepo `plugins/`
  directory. They are marked `origin: "builtin"` and `support: "first-party"`.
- **Third-party packages** are submitted by pull request under
  `entries/third-party/`. They are marked `origin: "third-party"` and
  `support: "community"`.

Generated files such as `index.json`, `generated-registry.json`, and
`registry-summary.json` are outputs. Do not hand-edit them.

## Published Data

- `https://plugins.elizacloud.ai/generated-registry.json` is the primary
  machine-readable registry.
- `https://plugins.elizacloud.ai/index.json` is a compatibility map from npm
  package name to `github:owner/repo`.
- `https://plugins.elizacloud.ai/registry-summary.json` is a compact summary
  for dashboards and checks.

## Third-Party Registration

Add one JSON file to `entries/third-party/`:

```json
{
  "package": "@your-scope/plugin-example",
  "repository": "github:your-org/plugin-example",
  "kind": "plugin",
  "description": "Short description shown in the registry.",
  "homepage": "https://github.com/your-org/plugin-example#readme",
  "tags": ["example", "elizaos"]
}
```

Requirements:

- `package` must be the published npm package name.
- `repository` must be `github:owner/repo`, with no `.git` suffix.
- `kind` must be `plugin`, `connector`, or `app`.
- `@elizaos/*` package names are reserved for first-party built-ins.
- The package and repository must be public and controlled by the submitter.
- Third-party entries are community packages, not first-party supported
  elizaOS packages.

The JSON schema is available at `schemas/third-party-package.schema.json`.

The elizaOS CLI can prepare and submit the pull request from a plugin project:

```sh
elizaos plugins submit /path/to/plugin
```

See [docs/add-third-party-plugin.md](docs/add-third-party-plugin.md) for the
full contributor checklist, CLI options, and manual JSON flow.

## Generating Locally

From this directory:

```sh
npm run generate-registry
npm run check
```

If this registry checkout is not inside the elizaOS monorepo, pass the monorepo
path:

```sh
ELIZA_REPO_ROOT=/path/to/eliza npm run generate-registry
```

Useful environment variables:

- `ELIZA_REPO_ROOT`: eliza monorepo path. Defaults to `../..`.
- `ELIZA_BUILTIN_REPO`: GitHub repo for built-in source links. Defaults to
  `elizaos/eliza`.
- `ELIZA_BUILTIN_BRANCH`: Git branch for built-in source links. Defaults to
  `main`.

## CI and Publishing

`generate-registry-json.yml` checks out the registry plus the elizaOS monorepo,
regenerates JSON outputs, and commits changed outputs back to this repository.

`deploy-to-gh-pages.yml` builds the registry site, copies the JSON data into the
site artifact, and publishes it to GitHub Pages with the `plugins.elizacloud.ai`
CNAME.
