
# Plugin System Guide

Extend your ElizaOS agent with plugins that add new capabilities, integrations, and behaviors. This guide covers the plugin architecture, available plugins, and how to create your own.

## 🎯 What Are ElizaOS Plugins?

Plugins are modular extensions that add functionality to your agent. They can provide new actions, supply contextual information, process interactions, and integrate with external services.

### Plugin Components

- ⚡ **Actions** - Commands and responses your agent can perform
- 📊 **Providers** - Supply dynamic context and information
- 🧠 **Evaluators** - Process and learn from interactions
- 🔧 **Services** - Manage state and external integrations
- 📅 **Tasks** - Handle scheduled and deferred operations
- 🎯 **Events** - React to system and platform events

## 🚀 Quick Start Guide

### Step 1: Install a Plugin

```bash
# Install a plugin via CLI
elizaos plugin install @elizaos/plugin-bootstrap

# Or add to your character file
{
  "plugins": ["@elizaos/plugin-bootstrap"]
}
```

### Step 2: Available Core Plugins

#### 📦 @elizaos/plugin-bootstrap

The essential plugin that provides core functionality:

**Actions:**
- `reply` - Generate contextual responses
- `followRoom` / `unfollowRoom` - Manage room subscriptions
- `muteRoom` / `unmuteRoom` - Control room notifications
- `sendMessage` - Send messages to specific rooms
- `updateEntity` - Manage entity information
- `updateRole` - Modify user roles
- `updateSettings` - Change agent settings
- `choice` - Make decisions between options

**Providers:**
- `time` - Current UTC timestamp
- `facts` - Stored facts and knowledge
- `entities` - Entity information
- `relationships` - User relationships
- `recentMessages` - Recent conversation context
- `character` - Agent personality info
- `settings` - Current configuration

**Services:**
- `TaskService` - Deferred task execution

#### 🗄️ @elizaos/plugin-sql

Database connectivity for persistent storage:

**Features:**
- PostgreSQL support for production
- PGLite support for development
- Automatic migration management
- Connection pooling
- Transaction support

**Configuration:**
```bash
# PostgreSQL
POSTGRES_URL=postgresql://user:pass@localhost:5432/elizaos

# Or PGLite (automatic)
# No configuration needed - uses local file
```

### Step 3: Configure Plugins

Plugins can be configured per character:

```json
{
  "name": "MyAgent",
  "plugins": [
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-sql"
  ],
  "settings": {
    "bootstrap": {
      "replyLength": "medium",
      "contextWindow": 10
    }
  }
}
```

## 🔧 Plugin Architecture

### How Plugins Work

1. **Registration** - Plugins register their components with the runtime
2. **Initialization** - Services start and connections establish
3. **Runtime Integration** - Actions, providers, and evaluators become available
4. **Event Handling** - Plugins respond to system events

### Plugin Structure

```typescript
// Example plugin structure
export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Adds custom functionality",
  
  actions: [
    // Custom actions
  ],
  
  providers: [
    // Context providers
  ],
  
  evaluators: [
    // Post-processing logic
  ],
  
  services: [
    // Stateful services
  ]
};
```

## 📚 Creating Custom Plugins

### Step 1: Use the Starter Template

```bash
# Copy the plugin starter
cp -r packages/plugin-starter packages/plugin-myfeature

# Navigate to your plugin
cd packages/plugin-myfeature

# Install dependencies
bun install
```

### Step 2: Define an Action

```typescript
import { Action, HandlerContext } from "@elizaos/core";

export const greetAction: Action = {
  name: "greet",
  description: "Greet a user by name",
  
  validate: async (context: HandlerContext) => {
    // Check if we have a name to greet
    return context.input.includes("greet");
  },
  
  handler: async (context: HandlerContext) => {
    const name = context.input.match(/greet (\w+)/)?.[1] || "friend";
    return {
      text: `Hello ${name}! How can I help you today?`,
      action: "GREET"
    };
  },
  
  examples: [
    { input: "greet Alice", output: "Hello Alice! How can I help you today?" },
    { input: "greet Bob", output: "Hello Bob! How can I help you today?" }
  ]
};
```

### Step 3: Create a Provider

```typescript
import { Provider, HandlerContext } from "@elizaos/core";

export const weatherProvider: Provider = {
  name: "weather",
  description: "Provides current weather information",
  
  get: async (context: HandlerContext) => {
    // In a real plugin, this would call a weather API
    const weather = {
      temperature: 72,
      conditions: "sunny",
      location: "San Francisco"
    };
    
    return `Current weather in ${weather.location}: ${weather.temperature}°F and ${weather.conditions}`;
  }
};
```

### Step 4: Build Your Plugin

```typescript
import { Plugin } from "@elizaos/core";
import { greetAction } from "./actions/greet";
import { weatherProvider } from "./providers/weather";

export const myPlugin: Plugin = {
  name: "my-weather-plugin",
  description: "Adds weather awareness and greeting capabilities",
  version: "1.0.0",
  
  actions: [greetAction],
  providers: [weatherProvider],
  
  // Optional initialization
  init: async (runtime) => {
    console.log("Weather plugin initialized!");
  }
};

export default myPlugin;
```

## 🎨 Plugin Best Practices

### Design Guidelines

1. **Single Responsibility** - Each plugin should do one thing well
2. **Minimal Dependencies** - Keep external dependencies light
3. **Error Handling** - Always handle errors gracefully
4. **Documentation** - Include clear examples and descriptions
5. **Testing** - Write tests for your plugin components

### Performance Tips

- Cache expensive operations
- Use async/await properly
- Clean up resources in services
- Implement timeouts for external calls
- Log appropriately (not too much)

### Security Considerations

- Validate all inputs
- Sanitize outputs
- Use environment variables for secrets
- Implement rate limiting where needed
- Follow principle of least privilege

## 🧪 Testing Plugins

### Unit Testing

```typescript
import { test, expect } from "bun:test";
import { greetAction } from "./actions/greet";

test("greet action responds correctly", async () => {
  const context = {
    input: "greet Alice",
    // ... other context properties
  };
  
  const result = await greetAction.handler(context);
  expect(result.text).toBe("Hello Alice! How can I help you today?");
});
```

### Integration Testing

```bash
# Test with your agent
elizaos dev --character ./test-character.json --plugin ./packages/plugin-myfeature

# The agent will load your plugin
# Test your actions in the chat
```

## 📦 Publishing Plugins

### Prepare for Publishing

1. **Clean Code** - Remove debug logs and comments
2. **Documentation** - Write clear README
3. **Version** - Follow semantic versioning
4. **License** - Choose appropriate license
5. **Tests** - Ensure all tests pass

### Publish to npm

```bash
# Build your plugin
bun run build

# Publish to npm
npm publish --access public
```

### Share with Community

1. Add to ElizaOS plugin registry
2. Create example character files
3. Write tutorial documentation
4. Share in Discord community

## 🔍 Available Plugin Hooks

### Action Lifecycle

1. **validate** - Check if action should run
2. **handler** - Execute the action
3. **afterAction** - Post-processing

### Provider Lifecycle

1. **get** - Retrieve current information
2. **cache** - Optional caching logic

### Service Lifecycle

1. **initialize** - Service startup
2. **start** - Begin operations
3. **stop** - Cleanup and shutdown

## 🚀 Next Steps

Now that you understand plugins:

1. **Explore Core Plugins** - Study `packages/plugin-bootstrap`
2. **Create Simple Plugin** - Start with one action
3. **Test Thoroughly** - Use the development tools
4. **Share Your Work** - Contribute to the ecosystem

For more advanced topics:
- [Plugin API Reference](/docs/api/plugins)
- [Service Development](/docs/technical/services)
- [Event System](/docs/technical/events)

---

**💡 Pro Tip**: Start by modifying an existing plugin before creating one from scratch. The `plugin-starter` template provides a working foundation with all the necessary boilerplate.