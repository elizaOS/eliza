# elizaOS Plugin

This is an elizaOS plugin built with the official plugin starter template.

## Getting Started

```bash
bun install
bun run build
bun run test
```

To create another plugin with the CLI:

```bash
elizaos create my-plugin --template plugin
```

The generated directory and package name keep the plugin convention. For
example, `my-plugin` becomes `plugin-my-plugin`.

## Development

```bash
# Rebuild on changes
bun run dev

# Run component and E2E test files
bun run test

# Run only component tests
bun run test:component

# Run only E2E test files
bun run test:e2e

# Type-check the plugin
bun run typecheck
```

## Layout

```text
src/
  plugin.ts             # Plugin definition, actions, providers, and services
  e2e/                  # E2E-style plugin test suites
  __tests__/            # Vitest component and integration tests
  frontend/             # Optional plugin UI example
```

## Publishing

This template does not rely on a CLI publish command. Use standard npm and git
workflows when the plugin is ready:

```bash
npm login
npm version patch
npm publish
git push origin main --tags
```

Before publishing, update `package.json`, this README, and any images or
metadata your plugin requires.

## Configuration

The `agentConfig` section in `package.json` declares every environment variable
or runtime parameter your plugin needs. Eliza reads this when installing the
plugin and prompts the operator for any required value at first run. Add as many
entries as you need; the schema for each entry is:

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `"string"`, `"number"`, or `"boolean"`. Numbers and booleans are coerced. |
| `description` | yes | Shown in the onboarding prompt. Be explicit about what the value is for. |
| `defaultValue` | no | Provided when the operator does not enter a value. Omit for secrets. |
| `sensitive` | no | When `true`, Eliza hides the value in logs and config dumps. Use for keys/tokens. |

```json
"agentConfig": {
  "pluginType": "elizaos:plugin:1.0.0",
  "pluginParameters": {
    "API_KEY": {
      "type": "string",
      "description": "Secret API key for the service. Required at runtime; do not commit values."
    },
    "BASE_URL": {
      "type": "string",
      "description": "Base URL of the service the plugin talks to. Override per environment.",
      "defaultValue": "https://api.example.com"
    }
  }
}
```
