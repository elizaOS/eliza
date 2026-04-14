# elizaOS Plugin

This is an elizaOS plugin built with the official plugin starter template.

## Getting Started

```bash
# Create a new plugin (automatically adds "plugin-" prefix)
elizaos create --type plugin solana
# This creates: plugin-solana
# Dependencies are automatically installed and built

# Navigate to the plugin directory
cd plugin-solana

# Start development immediately
elizaos dev
```

## Development

```bash
# Start development with hot-reloading (recommended)
elizaos dev

# OR start without hot-reloading
elizaos start
# Note: When using 'start', you need to rebuild after changes:
# bun run build

# Test the plugin
elizaos test
```

## Testing

elizaOS uses a dual testing approach that combines Vitest for component tests with a custom E2E test runner for integration testing within a live elizaOS runtime.

### Test Structure

```
src/
  __tests__/              # All tests live inside src
    *.test.ts            # Component tests (use Vitest runner)
    e2e/                 # E2E tests (use elizaOS test runner)
      *.ts               # E2E test files
      README.md          # E2E testing documentation
```

### Two Types of Tests

#### 1. Component Tests (Vitest)

- **Purpose**: Test individual functions/classes in isolation
- **Location**: `src/__tests__/*.test.ts`
- **Runner**: Vitest
- **Command**: `npx vitest`
- **Features**: Fast, isolated, uses mocks

```typescript
// Example: src/__tests__/plugin.test.ts
import { describe, it, expect } from "vitest";
import { starterPlugin } from "../plugin";

describe("Plugin Configuration", () => {
  it("should have correct plugin metadata", () => {
    expect(starterPlugin.name).toBe("plugin-starter");
  });
});
```

#### 2. E2E Tests (elizaOS Test Runner)

- **Purpose**: Test plugin behavior within a real elizaOS runtime
- **Location**: `src/__tests__/e2e/*.ts`
- **Runner**: elizaOS custom test runner
- **Command**: `elizaos test --type e2e`
- **Features**: Real runtime, real database, full integration

```typescript
// Example: src/__tests__/e2e/starter-plugin.ts
import { type TestSuite } from "@elizaos/core";

export const StarterPluginTestSuite: TestSuite = {
  name: "plugin_starter_test_suite",
  tests: [
    {
      name: "hello_world_action_test",
      fn: async (runtime) => {
        // Test with real runtime - no mocks needed!
        const action = runtime.actions.find((a) => a.name === "HELLO_WORLD");
        if (!action) {
          throw new Error("Action not found");
        }
        // Test real behavior...
      },
    },
  ],
};
```

### Running Tests

```bash
# Run all tests (both component and E2E)
elizaos test

# Run only component tests (fast, for TDD)
npx vitest
# or
elizaos test --type component

# Run only E2E tests (slower, full integration)
elizaos test --type e2e
```

### Key Differences

| Aspect          | Component Tests      | E2E Tests               |
| --------------- | -------------------- | ----------------------- |
| **Runner**      | Vitest               | elizaOS TestRunner      |
| **Environment** | Mocked               | Real runtime            |
| **Database**    | Mocked               | Real (PGLite)           |
| **Speed**       | Fast (ms)            | Slower (seconds)        |
| **Use Case**    | TDD, component logic | Integration, user flows |

### E2E Test Integration

E2E tests are integrated into your plugin by:

1. **Creating the test suite** in `src/__tests__/e2e/`
2. **Importing directly** in your plugin definition:

```typescript
// src/plugin.ts
import { StarterPluginTestSuite } from "./__tests__/e2e/starter-plugin";

export const starterPlugin: Plugin = {
  name: "plugin-starter",
  // ... other properties
  tests: [StarterPluginTestSuite], // Direct import, no tests.ts needed
};
```

### Writing Effective E2E Tests

E2E tests receive a real `IAgentRuntime` instance, allowing you to:

- Access real actions, providers, and services
- Interact with the actual database
- Test complete user scenarios
- Validate plugin behavior in production-like conditions

```typescript
{
  name: 'service_lifecycle_test',
  fn: async (runtime) => {
    // Get the real service
    const service = runtime.getService('starter');
    if (!service) {
      throw new Error('Service not initialized');
    }

    // Test real behavior
    await service.stop();
    // Verify cleanup happened...
  },
}
```

### Best Practices

1. **Use Component Tests for**:
   - Algorithm logic
   - Data transformations
   - Input validation
   - Error handling

2. **Use E2E Tests for**:
   - User scenarios
   - Action execution flows
   - Provider data integration
   - Service lifecycle
   - Plugin interactions

3. **Test Organization**:
   - Keep related tests together
   - Use descriptive test names
   - Include failure scenarios
   - Document complex test setups

The comprehensive E2E test documentation in `src/__tests__/e2e/README.md` provides detailed examples and patterns for writing effective tests.

## Publishing & Continuous Development

### Initial Setup

Before publishing your plugin, ensure you meet these requirements:

1. **npm Authentication**

   ```bash
   npm login
   ```

2. **GitHub Repository**
   - Create a public GitHub repository for this plugin
   - Add the 'elizaos-plugins' topic to the repository
   - Use 'main' as the default branch

3. **Required Assets**
   - Add images to the `images/` directory:
     - `logo.jpg` (400x400px square, <500KB)
     - `banner.jpg` (1280x640px, <1MB)

### Initial Publishing

```bash
# Test your plugin meets all requirements
elizaos publish --test

# Publish to npm + GitHub + registry (recommended)
elizaos publish
```

This command will:

- Publish your plugin to npm for easy installation
- Create/update your GitHub repository
- Submit your plugin to the elizaOS registry for discoverability

### Continuous Development & Updates

**Important**: After your initial publish with `elizaos publish`, all future updates should be done using standard npm and git workflows, not the elizaOS CLI.

#### Standard Update Workflow

1. **Make Changes**

   ```bash
   # Edit your plugin code
   elizaos dev  # Test locally with hot-reload
   ```

2. **Test Your Changes**

   ```bash
   # Run all tests
   elizaos test

   # Run specific test types if needed
   elizaos test component  # Component tests only
   elizaos test e2e       # E2E tests only
   ```

3. **Update Version**

   ```bash
   # Patch version (bug fixes): 1.0.0 → 1.0.1
   npm version patch

   # Minor version (new features): 1.0.1 → 1.1.0
   npm version minor

   # Major version (breaking changes): 1.1.0 → 2.0.0
   npm version major
   ```

4. **Publish to npm**

   ```bash
   npm publish
   ```

5. **Push to GitHub**
   ```bash
   git push origin main
   git push --tags  # Push version tags
   ```

#### Why Use Standard Workflows?

- **npm publish**: Directly updates your package on npm registry
- **git push**: Updates your GitHub repository with latest code
- **Automatic registry updates**: The elizaOS registry automatically syncs with npm, so no manual registry updates needed
- **Standard tooling**: Uses familiar npm/git commands that work with all development tools

### Alternative Publishing Options (Initial Only)

```bash
# Publish to npm only (skip GitHub and registry)
elizaos publish --npm

# Publish but skip registry submission
elizaos publish --skip-registry

# Generate registry files locally without publishing
elizaos publish --dry-run
```

## Configuration

The `agentConfig` section in `package.json` defines the parameters your plugin requires:

```json
"agentConfig": {
  "pluginType": "elizaos:plugin:1.0.0",
  "pluginParameters": {
    "API_KEY": {
      "type": "string",
      "description": "API key for the service"
    }
  }
}
```

Customize this section to match your plugin's requirements.

## Documentation

Provide clear documentation about:

- What your plugin does
- How to use it
- Required API keys or credentials
- Example usage
- Version history and changelog
