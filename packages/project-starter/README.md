# Project Starter

## Features

This Project Starter comes with a pre-configured character and a basic plugin structure to demonstrate core Eliza functionalities.

**Character: Orion**

- **Personality**: Responds directly and honestly to messages related to dating, relationships, men's mental health, personal growth, resilience, and philosophical inquiries.
- **Expertise**: Licensed clinical psychologist specializing in relationships, personal growth, and men's mental health.
- **Bio**: Includes details like being the creator of PsycHacks and author of "The Value of Others."
- **Topics**: Covers dating, men's mental health, personal growth, psychology, sexuality, anxiety, life purpose, and emotional wellbeing.
- **Pre-configured Plugins**:
  - `@elizaos/plugin-sql`
  - `@elizaos/plugin-openrouter`
  - `@elizaos/plugin-openai`
  - `@elizaos/plugin-discord`
  - `@elizaos/plugin-bootstrap`
  - `@elizaos/plugin-knowledge`
- **Message Examples**: Demonstrates interaction patterns for various scenarios.
- **Style Guide**: Defines how Orion should communicate, emphasizing concise, direct, practical, and honest responses.

**Starter Plugin (`starter`)**

- **Actions**:
  - `HELLO_WORLD`: A simple action that responds with "hello world!".
- **Providers**:
  - `HELLO_WORLD_PROVIDER`: A basic provider that returns "I am a provider".
- **Services**:
  - `StarterService`: A sample service demonstrating service integration within a plugin.
- **Models**:
  - `ModelType.TEXT_SMALL`: Example implementation (currently a placeholder).
  - `ModelType.TEXT_LARGE`: Example implementation (currently a placeholder).
- **API Routes**:
  - `GET /helloworld`: A sample API endpoint.
- **Event Handlers**:
  - Includes handlers for `MESSAGE_RECEIVED`, `VOICE_MESSAGE_RECEIVED`, `WORLD_CONNECTED`, and `WORLD_JOINED`.
- **Configuration**:
  - Uses `EXAMPLE_PLUGIN_VARIABLE` as an example environment variable.
- **Testing**:
  - Includes `StarterTestSuite` for comprehensive testing of character configuration, plugin initialization, actions, providers, and services.

## Getting Started

To get this project starter up and running, follow these steps:

1.  **Clone the Repository** (if you haven't already):

    ```bash
    # Via HTTPS
    git clone https://github.com/your-username/eliza.git
    # Or via SSH
    git clone git@github.com:your-username/eliza.git
    cd eliza
    ```

2.  **Install Dependencies**:
    Navigate to the root of the Eliza project or this specific package and install the necessary Node.js modules.

    ```bash
    npm install
    # Or if you are in the root and using workspaces
    # npm install
    ```

3.  **Configure Environment Variables**:
    Create a `.env` file in the root of this package (`packages/project-starter`) or configure your environment directly.
    Essential variables include:

    - `DISCORD_APPLICATION_ID`: Your Discord application ID (for `@elizaos/plugin-discord`).
    - `DISCORD_API_TOKEN`: Your Discord bot token (for `@elizaos/plugin-discord`).
    - `EXAMPLE_PLUGIN_VARIABLE` (Optional): An example variable for the starter plugin.

    Example `.env` file:

    ```env
    DISCORD_APPLICATION_ID="your_discord_app_id"
    DISCORD_API_TOKEN="your_discord_bot_token"
    EXAMPLE_PLUGIN_VARIABLE="my_example_value"
    ```

    Ensure any other plugins listed in `packages/project-starter/src/index.ts` (e.g., OpenAI, OpenRouter) have their respective API keys and configurations set up in the environment if you intend to use their full functionality.

4.  **Run the Project**:
    To start the Eliza instance with this project configuration, you typically run a command from the root of the Eliza monorepo or a script that initializes the Eliza core with this project. (Further instructions on running an Eliza project would typically be found in the main Eliza documentation).

    For development, you might use a command like:

    ```bash
    # Example command, adjust based on your main Eliza setup
    npm run dev -- --project project-starter
    ```

5.  **Run Tests**:
    To ensure everything is set up correctly and the plugin is functioning as expected:

    ```bash
    # Navigate to the package directory if not already there
    cd packages/project-starter

    # Run all tests for this package
    npm test

    # Run tests with coverage
    npm run test:coverage
    ```

# Project Starter Tests

This document provides information about the testing approach for the Project Starter plugin.

## Test Structure

The project uses a standardized testing approach that leverages core test utilities for consistency across the Eliza ecosystem.

### Core Test Utilities

The tests reuse core testing functionality from `@elizaos/core` through a set of utilities in the `__tests__/utils/core-test-utils.ts` file:

- `runCoreActionTests` - Validates action structure and functionality
- `runCoreModelTests` - Tests model behavior with various parameters
- `documentTestResult` - Records test results for debugging and documentation
- `createMockRuntime` - Creates a standardized runtime for testing
- `createMockMessage` - Creates test messages for action testing
- `createMockState` - Creates test state objects

### Test Categories

The test suite covers:

1. **Actions** - Testing the HELLO_WORLD action and action utilities
2. **Models** - Testing TEXT_SMALL and TEXT_LARGE model implementations
3. **Plugin Structure** - Validating the overall plugin structure
4. **Routes** - Testing API routes
5. **Integration** - End-to-end plugin functionality
6. **File Structure** - Ensuring proper package organization
7. **Configuration** - Testing configuration handling

## Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- actions.test.ts

# Run tests in watch mode
npm test -- --watch
```

## Test Implementation

### Action Tests

The action tests use the core action test utilities to validate:

- Action structure compliance
- Action validation functionality
- Action handler behavior
- Action formatting utilities

Example from `actions.test.ts`:

```typescript
// Run core tests on all plugin actions
it('should pass core action tests', () => {
  if (plugin.actions) {
    const coreTestResults = runCoreActionTests(plugin.actions);
    expect(coreTestResults).toBeDefined();
    // ...
  }
});
```

### Model Tests

The model tests validate:

- Model interface compliance
- Handling of various parameters
- Response formatting
- Error handling

Example from `models.test.ts`:

```typescript
it('should run core tests for TEXT_SMALL model', async () => {
  if (plugin.models && plugin.models[ModelType.TEXT_SMALL]) {
    const results = await runCoreModelTests(
      ModelType.TEXT_SMALL,
      plugin.models[ModelType.TEXT_SMALL]
    );
    // ...
  }
});
```

## Writing New Tests

When adding new features, follow these guidelines:

1. Use the core test utilities where possible
2. Structure tests in a consistent manner
3. Document test results using `documentTestResult`
4. Use the `createMockRuntime` for standardized testing

Example:

```typescript
it('should test my new feature', async () => {
  const runtime = createMockRuntime();
  const message = createMockMessage('Test message');
  const state = createMockState();

  const result = await myFeature(runtime, message, state);

  expect(result).toBeTruthy();
  documentTestResult('My feature test', result);
});
```

## Logs and Documentation

All tests use the Eliza logger for consistent reporting:

```typescript
logger.info(`TEST: ${testName}`);
logger.error(`ERROR: ${error.message}`);
```

## Debugging

To view detailed logs during test runs:

```bash
# Run with detailed logging
DEBUG=eliza:* npm test
```
