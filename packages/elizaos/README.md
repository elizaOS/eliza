# elizaOS CLI

Create and upgrade elizaOS project templates.

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

# Create a fullstack app workspace
elizaos create my-app --template fullstack-app

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
elizaos info --template fullstack-app
elizaos info --language typescript
```

## Templates

| Template | Description | Languages |
| --- | --- | --- |
| `plugin` | Plugin starter workspace | TypeScript |
| `fullstack-app` | Eliza-style app workspace backed by a local `eliza` checkout | TypeScript |

## Development

```bash
bun run build
bun run test
bun run test:packaged
```
