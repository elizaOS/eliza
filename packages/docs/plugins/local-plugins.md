---
title: Local plugin resolution
description: Load linked, installed, custom, and ejected plugins without publishing them.
---

The runtime resolves plugins from npm/workspace packages, recorded runtime
installs, drop-in directories, and ejected source. The implementation is
[`packages/agent/src/runtime/plugin-resolver.ts`](https://github.com/elizaOS/eliza/blob/develop/packages/agent/src/runtime/plugin-resolver.ts).

## Recommended development workflow

Scaffold and build a normal plugin package, then link it into the host project:

```bash
npx elizaos create my-plugin --template plugin
cd my-plugin
bun install
bun run build

cd ../my-agent
bun add link:../my-plugin
```

Add the package to the character's `plugins` array or the runtime allowlist,
then restart the host after rebuilding. A linked workspace package keeps its
own dependency-resolution context and does not require copying source into the
agent state directory.

## Drop-in directories

The runtime scans each immediate subdirectory of:

```text
<state-dir>/plugins/custom/
```

Each subdirectory is treated as one package. Its name and version come from
`package.json` when present, otherwise the directory name and version `0.0.0`
are used. The package still needs an importable entry point; use the generated
plugin template and build it before restarting the runtime.

Add other scan roots with `plugins.load.paths`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/srv/eliza/local-plugins"]
    }
  }
}
```

Paths support the same user-path expansion as other runtime configuration.
When the same package appears in multiple custom scan roots, the first record
wins.

## Loading policy

```json
{
  "plugins": {
    "allow": ["@acme/plugin-weather"],
    "deny": ["@elizaos/plugin-x"],
    "entries": {
      "@acme/plugin-weather": {
        "enabled": true,
        "config": {
          "endpoint": "https://weather.example.com"
        }
      }
    }
  }
}
```

- `plugins.allow` contributes explicit package names to the load set.
- `plugins.deny` wins over allowlists, auto-enable rules, installs, and custom
  discovery.
- `plugins.entries.<name>.enabled` turns an optional plugin on or off and
  `config` supplies its plugin-owned settings.
- `ELIZA_SKIP_PLUGINS` is a comma-separated operational denylist for one
  process start.

Plugin manifests may auto-enable installed candidates from configured
credentials or connector settings. Explicit deny policy still wins.

## Resolution order

For a selected plugin, the resolver prefers:

1. An ejected package under `<state-dir>/plugins/ejected/`.
2. A statically bundled or installed npm/workspace package.
3. A recorded runtime install under `<state-dir>/plugins/installed/`.
4. A custom drop-in package under `<state-dir>/plugins/custom` or a configured
   `plugins.load.paths` root.

Ejected source is intentionally an override. Custom plugins cannot replace a
core plugin with the same name, and a recorded install takes precedence over a
custom drop-in record.

The runtime accepts a default `Plugin` export first, then a named `plugin`
export, then a plugin-shaped named export. Prefer a default export so loading is
unambiguous.

## Runtime installs

Plugins installed through the plugin manager are represented in
`plugins.installs`. That object is runtime-managed state containing the source,
specifier, resolved install path, version, and installation time. Do not hand
author install records; use the plugin manager so installation and config stay
consistent.

## Troubleshooting

1. Run the plugin's `build`, `typecheck`, and `test` scripts.
2. Confirm `package.json` exports resolve to an existing ESM file.
3. Confirm the package name appears in the character, allowlist, enabled entry,
   install record, or a scanned drop-in directory.
4. Check both `plugins.deny` and `ELIZA_SKIP_PLUGINS`.
5. Inspect startup logs for the load reason and the first resolution error.
6. Restart the host after rebuilding a linked or drop-in package.

Do not mask a failed import by copying another version into a higher-priority
directory. Fix the package entry point or dependency closure reported by the
resolver.

## Related

- [Create a plugin](/plugins/create-a-plugin)
- [Configuration](/configuration)
- [Eject a plugin](/plugins/plugin-eject)
- [Publish a plugin](/plugins/publish)
