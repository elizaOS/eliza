# Cypress E2E Tests for Goals Plugin

## Current State

The Cypress E2E tests are set up but require an Eliza server to be running with the Goals plugin loaded. The tests are designed to test the actual API endpoints and frontend routes provided by the plugin.

## Available Test Files

1. **simple-api-test.cy.ts** - Basic API tests that work with the actual plugin endpoints
2. **simple-test.cy.ts** - Example test that visits the Cypress example page
3. **goals-api.cy.ts** - Comprehensive API tests (requires additional test endpoints not currently implemented)
4. **goals-management.cy.ts** - UI interaction tests (requires frontend components)
5. **ui-components.cy.ts** - Component tests (requires test page with components)
6. **ui-components-simple.cy.ts** - Simplified component tests

## Running the Tests

### Prerequisites

1. The Eliza server must be running with the Goals plugin loaded
2. The server should be accessible at the configured port (default: 3000)

### Manual Testing

1. Start the Eliza server in a separate terminal:

   ```bash
   npm run dev
   ```

2. Once the server is running, run the Cypress tests:

   ```bash
   # Run all tests in headless mode
   npm run test:e2e:headless

   # Run tests with Cypress UI
   npm run test:e2e

   # Run a specific test file
   npx cypress run --spec cypress/e2e/simple-api-test.cy.ts
   ```

### Automated Testing

The plugin includes test scripts that automatically start the server and run tests:

```bash
# Run E2E tests (starts server automatically)
npm run test:e2e

# Run E2E tests in CI mode
npm run test:e2e:ci
```

## Test Configuration

- **Base URL**: http://localhost:3000 (configured in cypress.config.ts)
- **Server Port**: The test scripts use port 3000 by default

## Known Issues

1. Some tests expect endpoints that don't exist (like `/api/test/reset`)
2. UI component tests expect a `/test-components` route that isn't implemented
3. The test scripts may have port conflicts if other services are running

## Future Improvements

1. Add mock data setup/teardown endpoints for testing
2. Create dedicated test pages for UI component testing
3. Add more integration tests for the actual Goals functionality
4. Implement proper test isolation and data cleanup
