# Plugins

Plugins are modular extensions that enhance the capabilities of ElizaOS agents. They provide a flexible way to add new functionality, integrate external services, and customize agent behavior across different platforms.

**Browse the various plugins the eliza dev community made here: [Package Showcase](/packages)**

[![](/img/plugins.png)](/packages)

> elizaOS maintains an official package registry at [github.com/elizaos-plugins/registry](https://github.com/elizaos-plugins/registry).

---

## Quick Start

### Creating a New Plugin

You can create a new ElizaOS plugin using the CLI:

```bash
# Using npm
npm create eliza@beta

# Or using npx
npx @elizaos/cli@beta create
```

When prompted, select "Plugin" as the type to create. The CLI will guide you through the setup process, creating a plugin with the proper structure and dependencies.

### Managing Plugins

There are several ways to add plugins to your ElizaOS project:

1. Add the plugin to your project's dependencies (`package.json`):

```json
{
  "dependencies": {
    "@elizaos/plugin-solana": "github:elizaos-plugins/plugin-solana",
    "@elizaos/plugin-twitter": "github:elizaos-plugins/plugin-twitter"
  }
}
```

2. Configure the plugin in your project's character definition:

```typescript
// In src/index.ts
export const character: Character = {
  name: 'MyAgent',
  plugins: ['@elizaos/plugin-twitter', '@elizaos/plugin-example'],
  // ...
};
```

3. Use the CLI tool to add or remove plugins:

```bash
# Add a plugin
npx @elizaos/cli plugins add @elizaos/plugin-twitter

# Remove a plugin
npx @elizaos/cli plugins remove @elizaos/plugin-twitter

# List available plugins
npx @elizaos/cli plugins list
```

```bash
# Full CLI options
Usage: elizaos plugins [options] [command]

manage elizaOS plugins

Options:
  -h, --help              display help for command

Commands:
  list|l [options]        list available plugins
  add|install <plugin>    add a plugin
  remove|delete <plugin>  remove a plugin
  help [command]          display help for command
```

### Plugin Configuration

Configure plugin settings in your character definition:

```typescript
{
  "settings": {
    "twitter": {
      "shouldRespondToMentions": true
      // Plugin-specific configuration
    }
  }
}
```

## Publishing Plugins

If you're a plugin developer, you can publish your plugin to make it available to others:

```bash
# Navigate to your plugin directory
cd my-eliza-plugin

# Build your plugin
npm run build

# Publish to the registry
npx @elizaos/cli publish
```

The publish command supports several options:

```bash
# Publish to npm instead of GitHub
npx @elizaos/cli publish --npm

# Test the publish process without making changes
npx @elizaos/cli publish --test

# Specify platform compatibility
npx @elizaos/cli publish --platform node
```

When publishing, your plugin will be:

1. Built and packaged
2. Published to GitHub (or npm if specified)
3. Added to the elizaOS registry (if you're a maintainer)

For first-time publishers, the CLI will guide you through setting up GitHub credentials for publishing.

---

## Plugin Architecture

Eliza uses a unified plugin architecture where everything is a plugin - including services, adapters, actions, evaluators, and providers. This approach ensures consistent behavior and better extensibility.

### Plugin Components

Each plugin can provide one or more of the following components:

| Component      | Purpose                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| **Services**   | Platform integrations (Discord, Twitter, etc.) or specialized capabilities |
| **Actions**    | Executable functions triggered by the agent                                |
| **Providers**  | Context providers that supply information to the agent                     |
| **Evaluators** | Response analyzers for quality and compliance                              |
| **Adapters**   | Database or storage system integrations                                    |

### Plugin Interface

All plugins implement the core Plugin interface:

```typescript
interface Plugin {
  name: string;
  description: string;
  config?: { [key: string]: any };

  // Optional initialization method
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;

  // Components
  services?: (typeof Service)[];
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapters?: Adapter[];

  // Additional features
  routes?: Route[];
  tests?: TestSuite[];
  events?: { [key: string]: ((params: any) => Promise<any>)[] };
}
```

### Service Implementation

Services are the core integration points for external platforms. A properly implemented service:

```typescript
import { Service, IAgentRuntime } from '@elizaos/core';

export class ExampleService extends Service {
  // Required: Define the service type (used for runtime registration)
  static serviceType = 'example';

  // Required: Describe what this service enables the agent to do
  capabilityDescription = 'Enables the agent to interact with the Example platform';

  // Store runtime for service operations
  constructor(protected runtime: IAgentRuntime) {
    super();
    // Initialize connections, setup event handlers, etc.
  }

  // Required: Static method to create and initialize service instance
  static async start(runtime: IAgentRuntime): Promise<ExampleService> {
    const service = new ExampleService(runtime);
    // Additional initialization if needed
    return service;
  }

  // Required: Clean up resources when service is stopped
  async stop(): Promise<void> {
    // Close connections, release resources
  }

  // Optional: Custom methods for your service functionality
  async sendMessage(content: string, channelId: string): Promise<void> {
    // Implementation
  }
}
```

## Plugin Structure

Each plugin repository should follow this structure:

```
plugin-name/
├── images/                # Branding assets
│   ├── logo.png           # Square logo (400x400px)
│   ├── banner.png         # Banner image (1280x640px)
│   └── screenshots/       # Feature screenshots
├── src/
│   ├── index.ts           # Main plugin entry point
│   ├── service.ts         # Service implementation
│   ├── actions/           # Plugin-specific actions
│   ├── providers/         # Data providers
│   ├── types.ts           # Type definitions
│   └── environment.ts     # Configuration validation
├── tests/                 # Test suite
├── package.json           # Plugin configuration and dependencies
└── README.md              # Plugin documentation
```

### Plugin Entry Point

Your plugin's `index.ts` should export a Plugin object:

```typescript
// Example plugin implementation
import { type Plugin } from '@elizaos/core';
import { ExampleService } from './service';
import { searchAction } from './actions/search';
import { statusProvider } from './providers/status';

const examplePlugin: Plugin = {
  name: 'example',
  description: 'Example platform integration for ElizaOS',
  services: [ExampleService],
  actions: [searchAction],
  providers: [statusProvider],
  init: async (config, runtime) => {
    // Perform any necessary initialization
    const apiKey = runtime.getSetting('EXAMPLE_API_KEY');
    if (!apiKey) {
      console.warn('EXAMPLE_API_KEY not provided');
    }
  },
};

export default examplePlugin;
```

### Plugin Configuration

Your plugin's `package.json` should include an `agentConfig` section:

```json
{
  "name": "@elizaos/plugin-example",
  "version": "1.0.0",
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the Example service"
      }
    }
  }
}
```

## Environment Variables and Secrets

Plugins access configuration through the runtime with the following precedence:

1. Character settings secrets (highest priority)
2. Character settings
3. Global environment settings

### Access Pattern

```typescript
// In your service implementation
const apiKey = runtime.getSetting('EXAMPLE_API_KEY');
const debugMode = runtime.getSetting('EXAMPLE_DEBUG_MODE'); // Returns boolean for "true"/"false" strings
```

### Configuration in Character File

```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-example"],
  "settings": {
    "example": {
      "enableFeatureX": true
    },
    "secrets": {
      "EXAMPLE_API_KEY": "your-api-key-here"
    }
  }
}
```

## Developing a Plugin

When developing a new plugin, focus on these key aspects:

1. **Service Implementation**: Create a solid service class following the pattern above
2. **Proper Error Handling**: Handle API failures gracefully
3. **Type Definitions**: Define clear interfaces and types
4. **Documentation**: Include detailed setup instructions
5. **Tests**: Add test cases for your functionality

### Testing Your Plugin

During development, you can test your plugin locally:

```bash
# Start with your plugin
npx @elizaos/cli start --plugin=./path/to/plugin

# Or with a specific character
npx @elizaos/cli start --character=./characters/test.character.json --plugin=./path/to/plugin
```

## Distribution & PR Requirements

When submitting a plugin to the [elizaOS Registry](https://github.com/elizaos-plugins/registry), include:

1. **Working Demo**: Screenshots or video of your plugin in action
2. **Test Results**: Evidence of successful integration and error handling
3. **Configuration Example**: Show how to properly configure your plugin
4. **Quality Checklist**:
   - [ ] Plugin follows the standard structure
   - [ ] Required branding assets are included
   - [ ] Documentation is complete
   - [ ] GitHub topics properly set
   - [ ] Tests are passing
   - [ ] Includes error handling

## FAQ

### What exactly is a plugin in ElizaOS?

A plugin is a modular extension that adds new capabilities to ElizaOS agents, such as API integrations, custom actions, or platform connections. Plugins allow you to expand agent functionality and share reusable components with other developers.

### When should I create a plugin versus using existing ones?

Create a plugin when you need custom functionality not available in existing plugins, want to integrate with external services, or plan to share reusable agent capabilities with the community.

### How do I manage plugin dependencies?

Plugin dependencies are managed through your project's `package.json`. You can add plugins directly using npm or the ElizaOS CLI, and they will be automatically loaded when your project starts.

### Can I use a plugin in development before publishing?

Yes, you can use the `--plugin` flag with the `start` command to include local plugins during development:

```bash
npx @elizaos/cli start --plugin=./path/to/plugin
```

### What's the difference between Actions and Services?

Actions handle specific agent responses or behaviors, while Services provide platform integrations (like Discord or Twitter) or ongoing background functionality that multiple actions might use.

### How do I handle rate limits with external APIs?

Implement proper backoff strategies in your service implementation and consider using a queue system for message handling to respect platform rate limits.

## Additional Resources

- [ElizaOS Registry](https://github.com/elizaos-plugins/registry)
- [Example Plugins](https://github.com/elizaos-plugins)
- [Discord Community](https://discord.gg/elizaos)
