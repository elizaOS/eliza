# Plugin Manager Plugin

The Plugin Manager Plugin for ElizaOS provides comprehensive plugin management capabilities including dynamic loading, unloading, registry integration, and configuration management.

## Features

- **Dynamic Plugin Management**: Load and unload plugins at runtime
- **Registry Integration**: Search, install, clone, and publish plugins
- **Configuration Management**: Check plugin configuration status and required API keys
- **Caching**: Efficient registry data caching to minimize API calls
- **Hot Reload**: Support for development workflows with hot reloading

## Installation

```bash
npm install @elizaos/plugin-plugin-manager
```

## Usage

```typescript
import { pluginManagerPlugin } from '@elizaos/plugin-plugin-manager';
import { createAgentRuntime } from '@elizaos/core';

const runtime = createAgentRuntime({
  // ... other configuration
  plugins: [pluginManagerPlugin],
});
```

## Available Actions

### Load Plugin

Load a plugin dynamically at runtime.

```
"Load the weather plugin"
"Enable @elizaos/plugin-weather"
```

### Unload Plugin

Unload a plugin from the runtime.

```
"Unload the weather plugin"
"Disable plugin-weather"
```

### Search Plugins

Search for plugins in the registry.

```
"Search for social media plugins"
"Find plugins for image processing"
```

### Install Plugin

Install a plugin from the registry.

```
"Install plugin @elizaos/plugin-example from registry"
"Install the weather plugin"
```

### Clone Plugin

Clone a plugin repository for development.

```
"Clone the weather plugin"
"Get the source code for @elizaos/plugin-example"
```

### Publish Plugin

Publish a plugin to npm registry.

```
"Publish my weather plugin"
"Release the plugin to npm"
```

## Services

### PluginManagerService

Core service for managing plugin lifecycle, including loading, unloading, and tracking plugin states.

### RegistryService

Manages cached registry data for efficient plugin discovery and search operations. Automatically refreshes cache every 30 minutes.

### PluginConfigurationService

Provides basic environment variable checking for plugin configuration requirements.

## Providers

- **pluginStateProvider**: Provides current state of loaded plugins
- **pluginConfigurationStatusProvider**: Shows configuration status and missing API keys
- **registryPluginsProvider**: Lists available plugins from the registry
- **pluginKnowledgeProvider**: Provides searchable knowledge about plugins

## Configuration

Set the plugin directory in your environment:

```bash
PLUGIN_DIRECTORY=./plugins
```

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test

# Run linter
npm run lint
```

## Testing

The plugin includes comprehensive unit tests. Run them with:

```bash
npm run test:unit
```

To run all tests including E2E tests:

```bash
npm run test
# or
npx elizaos test
```

### E2E Tests Fixed

The SQL plugin camelCase/snake_case issue has been resolved by ensuring Drizzle ORM receives the schema object during initialization. This fix enables proper column name mapping between TypeScript (camelCase) and PostgreSQL (snake_case).

If you encounter any E2E test issues, ensure you have:

1. Built the SQL plugin: `cd packages/plugin-sql && npm run build`
2. Built the CLI: `cd packages/cli && npm run build`
3. Built this plugin: `npm run build`

## License

MIT
