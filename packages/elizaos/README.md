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

### `elizaos plugins submit`

Generate third-party plugin metadata and, when maintainers provide a writable registry repository, open a pull request for that registry. The public discovery path is npm publication with the `elizaos` keyword.

```bash
elizaos plugins submit --dry-run
elizaos plugins submit --registry owner/repo
```

### `elizaos deploy`

Experimental Eliza Cloud deploy. Currently only `--dry-run` is functional and prints the planned deploy sequence.

```bash
elizaos deploy --dry-run
```

### `elizaos capability-router connect`

Connect a running Eliza agent to a remote capability-router endpoint or provision one via Eliza Cloud. See `elizaos capability-router connect --help` for the full flag list.

## Templates

| Template | Description | Languages |
| --- | --- | --- |
| `project` | Package-first elizaOS app with optional local source eject | TypeScript |
| `plugin` | Plugin starter workspace | TypeScript |

## Development

```bash
bun run build
bun run test
bun run test:packaged
```
