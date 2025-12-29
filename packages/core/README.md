# @elizaos/core

## Overview

The `@elizaos/core` package provides a robust foundation for building AI agents with dynamic interaction capabilities. It enables agents to manage entities, memories, and context, and to interact with external systems, going beyond simple message responses to handle complex scenarios and execute tasks effectively.

## Key Features

- **AgentRuntime:** Central orchestrator for managing agent lifecycle, plugins, and interactions.
- **Actions:** Define tasks the agent can perform, with validation and execution logic.
- **Providers:** Supply real-time data and context to the agent, enabling interaction with dynamic environments and external APIs.
- **Evaluators:** Process conversation data to extract insights, build long-term memory, and maintain contextual awareness.
- **Plugin System:** Extensible architecture allowing for modular addition of functionalities.
- **Entity and Memory Management:** Core support for tracking entities and their associated information.

## Installation

1.  Add `@elizaos/core` to your `agent/package.json` dependencies:

    ```json
    {
      "dependencies": {
        "@elizaos/core": "workspace:*"
      }
    }
    ```

2.  Navigate to your `agent/` directory.
3.  Install dependencies:
    ```bash
    bun install
    ```
4.  Build your project:
    ```bash
    bun run build
    ```

## Browser and Node.js Compatibility

The `@elizaos/core` package features a dual build system that provides optimized builds for both Node.js and browser environments:

- **Node.js Build**: Full API surface with all features including server utilities
- **Browser Build**: Optimized, minified build with browser-safe APIs and polyfills

The correct build is automatically selected based on your environment through package.json conditional exports. For browser usage, ensure you have the necessary polyfills installed:

```bash
npm install buffer crypto-browserify stream-browserify events
```

The dual build system uses conditional exports in package.json to automatically select the appropriate build based on the runtime environment.

## Configuration

The following environment variables are used by `@elizaos/core`. Configure them in a `.env` file at your project root.

- `LOG_LEVEL`: Logging verbosity (e.g., 'debug', 'info', 'error').
- `LOG_DIAGNOSTIC`: Enable/disable diagnostic logging (`true`/`false`).
- `LOG_JSON_FORMAT`: Output logs in JSON format (`true`/`false`).
- `DEFAULT_LOG_LEVEL`: Default log level if not in debug mode.
- `SECRET_SALT`: Secret salt for encryption purposes.
- `SENTRY_DSN`: Sentry DSN for error reporting.
- `SENTRY_ENVIRONMENT`: Sentry deployment environment (e.g., 'production', 'staging').
- `SENTRY_TRACES_SAMPLE_RATE`: Sentry performance tracing sample rate (0.0 - 1.0).
- `SENTRY_SEND_DEFAULT_PII`: Send Personally Identifiable Information to Sentry (`true`/`false`).

**Example `.env`:**

```plaintext
LOG_LEVEL=debug
LOG_DIAGNOSTIC=true
LOG_JSON_FORMAT=false
DEFAULT_LOG_LEVEL=info
SECRET_SALT=yourSecretSaltHere
SENTRY_DSN=yourSentryDsnHere
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=1.0
SENTRY_SEND_DEFAULT_PII=true
```

**Note:** Add your `.env` file to `.gitignore` to protect sensitive information.

## Core Architecture

`@elizaos/core` is built around a few key concepts that work together within the `AgentRuntime`.

### AgentRuntime

The `AgentRuntime` is the heart of the system. It manages the agent's lifecycle, loads plugins, orchestrates interactions, and provides a central point for actions, providers, and evaluators to operate. It's typically initialized with a set of plugins, including the `corePlugin` which provides foundational capabilities.

### Actions

Actions define specific tasks or capabilities the agent can perform. Each action typically includes:

- A unique `name`.
- A `description` explaining its purpose and when it should be triggered.
- A `validate` function to determine if the action is applicable in a given context.
- A `handler` function that executes the action's logic.

Actions enable the agent to respond intelligently and perform operations based on user input or internal triggers.

### Providers

Providers are responsible for supplying data and context to the `AgentRuntime` and its components. They can:

- Fetch data from external APIs or databases.
- Provide real-time information about the environment.
- Offer access to external services or tools.

This allows the agent to operate with up-to-date and relevant information.

### Evaluators

Evaluators analyze conversation data and other inputs to extract meaningful information, build the agent's memory, and maintain contextual awareness. They help the agent:

- Understand user intent.
- Extract facts and relationships.
- Reflect on past interactions to improve future responses.
- Update the agent's knowledge base.

## Getting Started

### Initializing with `corePlugin`

The `corePlugin` bundles essential actions, providers, and evaluators from `@elizaos/core`. To use it, add it to the `AgentRuntime` during initialization:

```typescript
import { AgentRuntime, corePlugin } from '@elizaos/core';

const agentRuntime = new AgentRuntime({
  plugins: [
    corePlugin,
    // You can add other custom or third-party plugins here
  ],
  // Other AgentRuntime configurations can be specified here
});

// After initialization, agentRuntime is ready to be used.
// You should see console messages like "✓ Registering action: <plugin actions>"
// indicating successful plugin registration.
```

### Example: Defining a Custom Action (Conceptual)

While `corePlugin` provides many actions, you might need to define custom actions for specific agent behaviors. Here's a conceptual outline:

```typescript
// myCustomAction.ts
// (This is a simplified conceptual example)

export const myCustomAction = {
  name: 'customGreet',
  description: 'Greets a user in a special way.',
  validate: async ({ context }) => {
    // Logic to determine if this action should run
    // e.g., return context.message.text.includes('special hello');
    return true; // Placeholder
  },
  handler: async ({ runtime, context }) => {
    // Logic to execute the action
    // e.g., runtime.sendMessage(context.roomId, "A very special hello to you!");
    console.log('Custom Greet action executed!');
    return { success: true, message: 'Custom greeting sent.' };
  },
};

// Then, this action would be registered with the AgentRuntime, typically via a custom plugin.
```

For detailed instructions on creating and registering plugins and actions, refer to the specific documentation or examples within the codebase.

## Development & Testing

### Running Tests

The `@elizaos/core` package uses **bun:test** for testing.

1.  **Prerequisites**:

    - Ensure `bun` is installed (`npm install -g bun`).
    - Environment variables in `.env` (as described in Configuration) are generally **not required** for most core tests but might be for specific integration tests if any.

2.  **Setup**:

    - Navigate to the `packages/core` directory: `cd packages/core`
    - Install dependencies: `bun install`

3.  **Execute Tests**:
    ```bash
    bun test
    ```
    Test results will be displayed in the terminal.

### TODO Items

The following improvements and features are planned for `@elizaos/core`:

- **Feature**: Add ability for plugins to register their sources (Context: Exporting a default `sendMessageAction`).
- **Enhancement**: Improve formatting of posts (Context: Returning formatted posts joined by a newline).
- **Bug**: Resolve server ID creation/retrieval issues (Context: Creating a room with specific world, name, and server IDs).
- **Enhancement**: Refactor message sending logic to an `ensureConnection` approach (Context: Sending messages to room participants).

## Troubleshooting & FAQ

### Common Issues

- **AgentRuntime not responding to triggers**:

  - **Cause**: Improperly defined action `validate` functions or handlers. Trigger conditions might not be met.
  - **Solution**: Verify `validate` functions correctly identify trigger conditions. Ensure `handler` functions execute as intended. Check console logs for errors during validation/handling.

- **Provider data is outdated/incorrect**:

  - **Cause**: Issues with external data source integration or API failures.
  - **Solution**: Check API connections and ensure the provider's data fetching logic is accurate. Review network configurations if needed.

- **Evaluator fails to maintain context**:
  - **Cause**: Evaluator not capturing necessary facts/relationships correctly.
  - **Solution**: Review evaluator configuration. Ensure it uses correct data from `AgentRuntime` and is updated with the latest configuration for accurate context.

### Frequently Asked Questions

- **Q: How do I define and use a new Action?**

  - **A**: Define an action object with `name`, `description`, `validate`, and `handler` functions. Integrate it into `AgentRuntime` usually by creating a plugin that registers the action. Ensure the action's name and description clearly align with its task for proper triggering.

- **Q: My action is registered, but the agent is not calling it.**

  - **A**: Double-check the action's `name` and `description` for clarity and relevance to the triggering conditions. Verify that the `validate` function correctly returns `true` (or a truthy value indicating applicability) under the desired conditions. Inspect logs for any errors or warnings related to your action.

- **Q: Can Providers access external API data?**

  - **A**: Yes, Providers are designed to interact with external systems, including fetching data from external APIs. This enables the agent to use real-time, dynamic context.

- **Q: How do I extend the agent's evaluation capabilities?**

  - **A**: Implement custom evaluators and integrate them with `AgentRuntime` (typically via a plugin). These can be tailored to extract specific information, enhancing the agent's memory and contextual understanding.

- **Q: How can I create a mock environment for testing?**
  - **A**: The package may include mock adapters (e.g., `MockDatabaseAdapter` if it's part of core utilities) that simulate interactions (like database connections) without actual external dependencies, facilitating controlled testing.

### Debugging Tips

- Utilize console logs (`LOG_LEVEL=debug`) for detailed error messages and execution flow during action validation and handler execution.
- Use mock classes/adapters where available to simulate environments and isolate functions for testing specific behaviors.
- Ensure `AgentRuntime` is loaded with the correct configurations and plugins.

---
