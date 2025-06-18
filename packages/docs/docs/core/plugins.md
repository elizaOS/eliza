---
sidebar_position: 8
title: Plugin System
description: Learn about ElizaOS plugins - modular extensions that enhance agent capabilities
keywords: [plugins, extensions, modules, development, publishing, registry, npm, GitHub]
image: /img/plugins.png
---

# Plugins

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

Plugins are modular extensions that enhance the capabilities of ElizaOS agents. They provide a flexible way to add new functionality, integrate external services, and customize agent behavior across different platforms.

:::info
Key Improvements in V2

1. **Unified API**: Almost everything is accessible via `runtime.methodName()` in the agent runtime for simpler development
2. **Enhanced Model System**: The new `useModel` approach allows for flexible model provider registration
3. **Events System**: Formal support for event-based programming
4. **Plugin Creation Workflow**: Simplified creation and testing via CLI
5. **Testing Infrastructure**: Built-in support for plugin testing
6. **No Monorepo Required**: Complete plugin development without touching the core codebase
7. **Plugin Registry**: Manages the catalog of available plugins and handles their registration with the runtime
8. **Bootstrap Plugin**: Initializes core functionality required for all agents to operate
   :::

The ElizaOS plugin system maintains the same basic concept as previous versions, with several new extension points (events, routes, tests, models) and features that significantly improve the developer experience.

**Browse plugins the elizaOS community made here: [Package Showcase](/packages)**

[![](/img/plugins.png)](/packages)

> elizaOS maintains an official package registry at [github.com/elizaos-plugins/registry](https://github.com/elizaos-plugins/registry).

---

## Quick Start

The new CLI tool introduces a streamlined workflow for plugin development without ever needing to touch the ElizaOS monorepo directly:

1. **Create**: `bun create eliza` or `elizaos create` - Initialize a new plugin project with proper structure
2. **Develop**: Edit the plugin code in the generated project structure
3. **Test**: `elizaos test` - Test the plugin functionality
4. **Run**: `elizaos start` - Run the plugin with a default agent
5. **Publish**: `elizaos publish` - Share your plugin with others

### Creating a New Plugin

You can create a new ElizaOS plugin using either method:

```bash
# Using bun create (recommended)
bun create eliza

# Or using the CLI directly
elizaos create
```

When prompted, select "Plugin" as the type to create. The CLI will guide you through the setup process, creating a plugin with the proper structure and dependencies.

---

### Managing Plugins

There are several ways to add plugins to your ElizaOS project:

<Tabs>
  <TabItem value="cli" label="Via CLI Commands (Recommended)">
    ```bash
    # Add a plugin - supports multiple formats
    elizaos plugins add openai                    # Short name
    elizaos plugins add @elizaos/plugin-openai   # Full package name
    elizaos plugins add plugin-openai            # With plugin prefix
    
    # Add from GitHub
    elizaos plugins add github:owner/repo
    elizaos plugins add https://github.com/owner/repo
    
    # Add with specific branch or tag
    elizaos plugins add plugin-name --branch main
    elizaos plugins add plugin-name --tag v1.0.0
    
    # Skip environment variable prompts
    elizaos plugins add plugin-name --skip-env-prompt
    
    # Remove a plugin
    elizaos plugins remove @elizaos/plugin-farcaster
    
    # List available plugins (v1.x by default)
    elizaos plugins list
    
    # List all plugins with version info
    elizaos plugins list --all
    
    # List v0.x compatible plugins
    elizaos plugins list --v0
    
    # List installed plugins in current project
    elizaos plugins installed-plugins
    ```
  </TabItem>
  
  <TabItem value="package" label="Via package.json">
    ```json
    {
      "dependencies": {
        "@elizaos/plugin-solana": "github:elizaos-plugins/plugin-solana",
        "@elizaos/plugin-farcaster": "github:elizaos-plugins/plugin-farcaster"
      }
    }
    ```
  </TabItem>
  
  <TabItem value="character" label="Via Character Definition">
    ```json
    // In your character JSON file
    {
      "name": "MyAgent",
      "plugins": ["@elizaos/plugin-farcaster", "@elizaos/plugin-example"],
      // ...
    }
    ```
    
    Note: Plugins specified in character files are automatically loaded when the agent starts.
  </TabItem>
</Tabs>

---

### Plugin Configuration

Configure plugin settings in your character definition:

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

### Plugin Loading Process

The AgentRuntime automatically loads the Bootstrap Plugin during initialization, before any other plugins:

```typescript
async initialize() {
  // Register bootstrap plugin
  await this.registerPlugin(bootstrapPlugin);

  // Then register additional plugins
  for (const plugin of this.plugins) {
    await this.registerPlugin(plugin);
  }

  // Initialize other components
  // ...
}
```

---

### Publishing Plugins

If you're a plugin developer, you can publish your plugin to make it available to others. The ElizaOS CLI provides several options for publishing your plugin depending on your needs.

First, make sure your plugin is built and ready for distribution:

```bash
# Navigate to your plugin directory
cd my-eliza-plugin

# Build your plugin
npm run build
```

<Tabs>
  <TabItem value="full" label="Full Publishing (Default)">
    The default publishing process publishes to npm, GitHub, and submits to the ElizaOS registry:

    ```bash
    # Full publish (npm + GitHub + registry)
    elizaos publish
    ```

    This will:
    1. Build and publish your plugin to npm
    2. Create or update a GitHub repository
    3. Submit a pull request to the ElizaOS registry (if you're a maintainer)

    For first-time publishers, the CLI will guide you through setting up GitHub credentials.

  </TabItem>

  <TabItem value="npm" label="npm Only">
    To publish only to npm (skip GitHub and registry):

    ```bash
    # Publish to npm only
    elizaos publish --npm
    ```

    This allows users to install your plugin using standard npm commands:

    ```bash
    npm install @your-scope/plugin-name
    ```

    npm-only publishing is useful when you want to:
    - Maintain your own package namespace
    - Use existing npm workflows
    - Skip GitHub repository creation

  </TabItem>

  <TabItem value="testing" label="Test Mode">
    Before publishing, validate the process without making any changes:

    ```bash
    # Test the publish process
    elizaos publish --test
    ```

    This runs through all the packaging and validation steps without actually publishing anything.

    Test mode is helpful for:
    - Verifying your plugin structure is correct
    - Ensuring all required files are present
    - Checking that dependencies are properly configured
    - Validating that your plugin can be built successfully

  </TabItem>

  <TabItem value="dry-run" label="Dry Run">
    Generate registry files locally without publishing:

    ```bash
    # Generate registry metadata locally
    elizaos publish --dry-run
    ```

    This creates the registry metadata files in `packages/registry` without publishing anywhere.

  </TabItem>

  <TabItem value="skip-registry" label="Skip Registry">
    Publish to npm and GitHub but skip the registry submission:

    ```bash
    # Skip registry PR creation
    elizaos publish --skip-registry
    ```

    Useful when you want to publish publicly but not submit to the official registry yet.

  </TabItem>
</Tabs>

:::info Publishing Requirements
When publishing a plugin:

1. **Package.json Requirements**:

   - Valid `name` and `version` fields
   - Proper `agentConfig` section with `pluginType`
   - Repository URL (for GitHub publishing)

2. **For Registry Submission**:
   - Working demo/screenshots
   - Test results showing successful integration
   - Configuration examples
   - Complete documentation
     :::

---

### Advanced Plugin Commands

The CLI also provides commands for plugin development and migration:

<Tabs>
  <TabItem value="generate" label="Generate Plugin">
    Generate a new plugin using AI-powered code generation:

    ```bash
    # Interactive generation
    elizaos plugins generate

    # With spec file
    elizaos plugins generate --spec-file plugin-spec.json

    # Skip tests/validation
    elizaos plugins generate --skip-tests --skip-validation
    ```

    Requires an Anthropic API key (via `--api-key` or `ANTHROPIC_API_KEY` env var).

  </TabItem>

  <TabItem value="upgrade" label="Upgrade Plugin">
    Upgrade a v0.x plugin to v1.x using AI-powered migration:

    ```bash
    # From GitHub repository
    elizaos plugins upgrade github:owner/repo

    # From local folder
    elizaos plugins upgrade ./path/to/plugin

    # Skip validation steps
    elizaos plugins upgrade ./plugin --skip-tests
    ```

    This command helps migrate legacy plugins to the new architecture.

  </TabItem>
</Tabs>

---

## Plugin Architecture

Eliza uses a unified plugin architecture where everything is a plugin - including services, adapters, actions, evaluators, and providers. This approach ensures consistent behavior and better extensibility.

### Plugin Components

Each plugin can provide one or more of the following components:

| Component          | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| **Services**       | Platform integrations (Discord, Telegram, etc.) or specialized capabilities     |
| **Actions**        | Executable functions triggered by the agent (reply, generate content, etc.)     |
| **Providers**      | Context providers that supply info to the agent during decision making          |
| **Evaluators**     | Analyze conversations to extract insights and improve future interactions       |
| **Adapters**       | Database or storage system integrations                                         |
| **Model Handlers** | Register handlers for different model types (text generation, embeddings, etc.) |
| **Event Handlers** | React to system events like messages, connections, or actions                   |
| **API Routes**     | Add custom REST endpoints to the agent's HTTP interface                         |
| **Tests**          | Include test suites to verify plugin functionality                              |

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
  models?: ModelHandler[]; // For registering model providers

  // Dependencies
  dependencies?: string[]; // Required plugin dependencies
  testDependencies?: string[]; // Additional dependencies for testing
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
  "packageType": "plugin",
  "platform": "node",
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

### Environment Variables and Secrets

Plugins access configuration through the runtime with the following precedence:

1. Character settings secrets (highest priority)
2. Character settings
3. Global environment settings

#### Access Pattern

```typescript
// In your service implementation
const apiKey = runtime.getSetting('EXAMPLE_API_KEY');
const debugMode = runtime.getSetting('EXAMPLE_DEBUG_MODE'); // Returns boolean for "true"/"false" strings
```

#### Configuration in Character File

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

---

## Bootstrap Plugin

The Bootstrap Plugin is a foundational component of ElizaOS that initializes the core functionality required for agents to operate. It's automatically loaded as part of the initialization process, establishing the minimum viable capabilities that all agents need.

```typescript
export const bootstrapPlugin: Plugin = {
  name: 'bootstrap',
  description: 'Agent bootstrap with basic actions and evaluators',
  actions: [...],
  events: {...},
  evaluators: [...],
  providers: [...],
  services: [TaskService, ScenarioService],
};
```

The Bootstrap Plugin registers essential components across several categories to provide a foundation for all agents. These components can be extended by custom plugins.

<Tabs>
  <TabItem value="actions" label="Actions">
    | Action                 | Description                                     |
    | ---------------------- | ----------------------------------------------- |
    | `replyAction`          | Generates and sends a response to a message     |
    | `followRoomAction`     | Enables an agent to actively follow a room      |
    | `unfollowRoomAction`   | Stops an agent from following a room            |
    | `muteRoomAction`       | Mutes notifications from a room                 |
    | `unmuteRoomAction`     | Unmutes notifications from a room               |
    | `sendMessageAction`    | Sends a message to a specific room              |
    | `ignoreAction`         | Explicitly ignores a message                    |
    | `noneAction`           | Acknowledges a message without taking action    |
    | `updateEntityAction`   | Updates properties of an entity                 |
    | `choiceAction`         | Presents choices to users and handles responses |
    | `updateRoleAction`     | Updates a user's role in a world                |
    | `updateSettingsAction` | Updates agent or world settings                 |
  </TabItem>
  
  <TabItem value="providers" label="Providers">
    | Provider                 | Description                                                |
    | ------------------------ | ---------------------------------------------------------- |
    | `characterProvider`      | Provides the agent's personality and configuration         |
    | `recentMessagesProvider` | Retrieves recent conversation history                      |
    | `knowledgeProvider`      | Supplies factual information from the knowledge base       |
    | `timeProvider`           | Provides awareness of current time and date                |
    | `entitiesProvider`       | Supplies information about entities in the current context |
    | `relationshipsProvider`  | Provides information about entity relationships            |
    | `factsProvider`          | Retrieves relevant facts from memory                       |
    | `roleProvider`           | Provides role information within worlds                    |
    | `settingsProvider`       | Supplies configured settings                               |
    | `anxietyProvider`        | Informs agent of potential issues to be careful about      |
    | `attachmentsProvider`    | Handles media and file attachments                         |
    | `providersProvider`      | Meta-provider with information about available providers   |
    | `actionsProvider`        | Meta-provider with information about available actions     |
    | `evaluatorsProvider`     | Meta-provider with information about available evaluators  |
    | `choiceProvider`         | Manages choice-based interactions                          |
    | `capabilitiesProvider`   | Provides information about agent capabilities              |
  </TabItem>
  
  <TabItem value="services" label="Services & Evaluators">
    **Services:**

    | Service           | Purpose                                          |
    | ----------------- | ------------------------------------------------ |
    | `TaskService`     | Manages deferred, scheduled, and repeating tasks |
    | `ScenarioService` | Handles scenario-based interactions and testing  |

    **Evaluators:**

    | Evaluator             | Description                                           |
    | --------------------- | ----------------------------------------------------- |
    | `reflectionEvaluator` | Enables self-awareness and learning from interactions |

  </TabItem>
  
  <TabItem value="events" label="Event Handlers">
    The Bootstrap Plugin registers handlers for key system events that enable the core message processing flow:

    **Core Events:**
    - `MESSAGE_RECEIVED` - Processes new messages and generates responses
    - `REACTION_RECEIVED` - Tracks reactions to messages
    - `VOICE_MESSAGE_RECEIVED` - Handles audio messages
    - `POST_GENERATED` - Creates social media content
    - `MESSAGE_SENT` - Logs outgoing messages

    **World Events:**
    - `WORLD_JOINED` / `WORLD_CONNECTED` - Synchronizes data when joining worlds
    - `ENTITY_JOINED` / `ENTITY_LEFT` - Manages entity presence

    **Lifecycle Events:**
    - `ACTION_STARTED` / `ACTION_COMPLETED` - Tracks action execution
    - `EVALUATOR_STARTED` / `EVALUATOR_COMPLETED` - Monitors evaluator processing
    - `RUN_STARTED` / `RUN_ENDED` / `RUN_TIMEOUT` - Manages message processing lifecycle

    The message processing flow follows these steps:
    1. Receive message via `MESSAGE_RECEIVED` event
    2. Save message to memory
    3. Check if agent should respond
    4. If responding, compose state from providers
    5. Generate a response using the language model
    6. Process any actions specified in the response
    7. Run evaluators on the conversation
    8. Emit lifecycle events throughout the process

  </TabItem>
</Tabs>

### Extending Bootstrap Functionality

While the Bootstrap Plugin provides core functionality, it's designed to be extended by other plugins. Custom plugins can:

1. **Add new actions** - Extend the agent's capabilities
2. **Register additional providers** - Supply more contextual information
3. **Add evaluators** - Create new ways to analyze and learn from interactions
4. **Handle additional events** - React to more system events
5. **Initialize custom services** - Provide new functionality

When working with plugins in relation to the Bootstrap Plugin:

1. **Don't modify bootstrap directly** - Instead, create custom plugins to extend functionality
2. **Understand provider contribution** - Know how each provider contributes to the agent's context
3. **Learn the core actions** - Become familiar with the actions that all agents can perform
4. **Leverage event handlers** - Use the event system for reactive behavior
5. **Extend, don't replace** - Build on top of bootstrap functionality rather than replacing it

---

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
# Start with your plugin from character file
elizaos start --character=./characters/test.character.json

# Character file can specify plugins:
{
  "name": "TestAgent",
  "plugins": ["./path/to/local/plugin", "@elizaos/plugin-example"]
}
```

Note: The `--plugins` flag mentioned in some examples is not currently implemented. Plugins should be specified in character files or added to the project dependencies.

### Distribution & PR Requirements

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

---

## FAQ

### What exactly is a plugin in ElizaOS?

A plugin is a modular extension that adds new capabilities to ElizaOS agents, such as API integrations, custom actions, or platform connections. Plugins allow you to expand agent functionality and share reusable components with other developers.

### When should I create a plugin versus using existing ones?

Create a plugin when you need custom functionality not available in existing plugins, want to integrate with external services, or plan to share reusable agent capabilities with the community.

### How do I manage plugin dependencies?

Plugin dependencies are managed through your project's `package.json`. You can add plugins using the `elizaos plugins add` command or npm directly. Plugins specified in character files are automatically loaded when the agent starts.

### Can I use a plugin in development before publishing?

Yes, you can reference local plugins in your character file:

```json
{
  "name": "DevAgent",
  "plugins": ["./path/to/local/plugin"]
}
```

### What's the difference between Actions and Services?

Actions handle specific agent responses or behaviors, while Services provide platform integrations (like Discord or Telegram) or ongoing background functionality that multiple actions might use.

### How do I handle rate limits with external APIs?

Implement proper backoff strategies in your service implementation and consider using a queue system for message handling to respect platform rate limits.

### What's the difference between publish options?

- **Default (`elizaos publish`)**: Publishes to npm, GitHub, and submits to registry
- **npm only (`--npm`)**: Only publishes to npm registry
- **Test (`--test`)**: Validates everything without publishing
- **Dry run (`--dry-run`)**: Generates registry files locally
- **Skip registry (`--skip-registry`)**: Publishes to npm/GitHub but skips registry PR

## Additional Resources

- [ElizaOS Registry](https://github.com/elizaos-plugins/registry)
- [Example Plugins](https://github.com/elizaos-plugins)
- [Discord Community](https://discord.gg/elizaos)
