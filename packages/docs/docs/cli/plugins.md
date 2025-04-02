---
sidebar_position: 5
---

# Plugin Command

The `plugin` command helps you manage ElizaOS plugins, including publishing them to the registry.

## Usage

```bash
elizaos plugin <action> [options]
```

## Actions

| Action    | Description                      |
| --------- | -------------------------------- |
| `publish` | Publish a plugin to the registry |

## Publishing Plugins

Publish your plugin to make it available for others to use:

```bash
elizaos plugin publish
```

### Options for publish

| Option                      | Description                            |
| --------------------------- | -------------------------------------- |
| `-r, --registry <registry>` | Specify a custom registry URL          |
| `-n, --npm`                 | Publish to npm instead of the registry |
| `-t, --test`                | Test the publishing process            |
| `-p, --platform <platform>` | Specify platform compatibility         |

### Publishing Process

The publish command will:

1. Validate your plugin directory
2. Check your GitHub credentials
3. Validate your package.json
4. Build your plugin
5. Publish to the specified registry

## Examples

### Testing the Publishing Process

```bash
elizaos plugin publish --test
```

### Publishing to npm

```bash
elizaos plugin publish --npm
```

### Specifying Platform Compatibility

```bash
elizaos plugin publish --platform node
```

## Requirements

To publish a plugin, you need:

1. A proper plugin name (e.g., `@elizaos/plugin-name`)
2. A complete package.json with:
   - name
   - version
   - description
   - main
   - types
   - dependencies
3. GitHub credentials for the registry

## Related Commands

- [`create`](./create.md): Create a new plugin
- [`project`](./projects.md): Add plugins to projects
- [Quickstart Guide](../quickstart.md): Project and plugin structure
