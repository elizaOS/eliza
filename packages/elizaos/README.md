# elizaOS CLI

Create and upgrade elizaOS projects and plugins.

## Installation

```bash
# Interactive home screen
npx elizaos

# Or run a command directly
npx elizaos create
```

## Commands

### `elizaos create`

Create a new project from a packaged template.

```bash
# Interactive template selection
elizaos create

# Create a project
elizaos create my-project --template project

# Backwards-compatible alias for the project template
elizaos create my-project --template project

# Create a TypeScript plugin starter
elizaos create plugin-foo --template plugin
```

### `elizaos upgrade`

Upgrade the current generated project to the latest packaged template.

```bash
elizaos upgrade
elizaos upgrade --check
```

### `elizaos info`

Show available templates and languages.

```bash
elizaos info
elizaos info --template project
elizaos info --language typescript
```

## Templates

| Template | Description | Languages |
| --- | --- | --- |
| `project` | Package-first elizaOS app with optional local source eject | TypeScript |
| `plugin` | Plugin starter workspace | TypeScript |

`project` remains accepted as an alias for `project`.

## Development

```bash
bun run build
bun run test
bun run test:packaged
```
