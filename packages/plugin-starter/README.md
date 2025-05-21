# ElizaOS Plugin

This is an ElizaOS plugin built with the official plugin starter template.

## Development

```bash
# Start development with hot-reloading
npm run dev

# Build the plugin
npm run build

# Test the plugin
npm run test
```

## Testing

ElizaOS provides a comprehensive testing structure for plugins:

### Test Structure

- **Component Tests** (`__tests__/` directory):

  - **Unit Tests**: Test individual functions/classes in isolation
  - **Integration Tests**: Test how components work together
  - Run with: `npm run test:component`

- **End-to-End Tests** (`e2e/` directory):

  - Test the plugin within a full ElizaOS runtime
  - Run with: `npm run test:e2e`

- **Running All Tests**:
  - `npm run test` runs both component and e2e tests

### Writing Tests

Component tests use Vitest:

```typescript
// Unit test example (__tests__/plugin.test.ts)
describe('Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(starterPlugin.name).toBe('plugin-starter');
  });
});

// Integration test example (__tests__/integration.test.ts)
describe('Integration: HelloWorld Action with StarterService', () => {
  it('should handle HelloWorld action with StarterService', async () => {
    // Test interactions between components
  });
});
```

E2E tests use ElizaOS test interface:

```typescript
// E2E test example (e2e/starter-plugin.test.ts)
export class StarterPluginTestSuite implements TestSuite {
  name = 'plugin_starter_test_suite';
  tests = [
    {
      name: 'example_test',
      fn: async (runtime) => {
        // Test plugin in a real runtime
      },
    },
  ];
}

export default new StarterPluginTestSuite();
```

The test utilities in `__tests__/test-utils.ts` provide mock objects and setup functions to simplify writing tests.

## Publishing

Before publishing your plugin to the ElizaOS registry, ensure you meet these requirements:

1. **GitHub Repository**

   - Create a public GitHub repository for this plugin
   - Add the 'elizaos-plugins' topic to the repository
   - Use 'main' as the default branch

2. **Required Assets**

   - Add images to the `images/` directory:
     - `logo.jpg` (400x400px square, <500KB)
     - `banner.jpg` (1280x640px, <1MB)

3. **Publishing Process**

   ```bash
   # Check if your plugin meets all registry requirements
   npx elizaos publish --test

   # Publish to the registry
   npx elizaos publish
   ```

After publishing, your plugin will be submitted as a pull request to the ElizaOS registry for review.

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
