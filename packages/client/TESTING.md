# ElizaOS Client Testing Guide

This guide provides comprehensive information about testing the ElizaOS client application.

## Table of Contents

1. [Overview](#overview)
2. [Testing Stack](#testing-stack)
3. [Test Types](#test-types)
4. [Running Tests](#running-tests)
5. [Writing Tests](#writing-tests)
6. [Test Structure](#test-structure)
7. [Best Practices](#best-practices)
8. [CI/CD Integration](#cicd-integration)
9. [Troubleshooting](#troubleshooting)

## Overview

The ElizaOS client uses a comprehensive testing strategy to ensure reliability, maintainability, and user experience quality. Our testing approach includes:

- **Unit Tests**: Test individual functions and hooks in isolation
- **Component Tests**: Test React components in isolation
- **E2E Tests**: Test complete user workflows
- **Visual Regression Tests**: Ensure UI consistency
- **Accessibility Tests**: Ensure the app is accessible to all users

## Testing Stack

- **Vitest**: Unit testing framework for functions and hooks
- **Cypress**: Component and E2E testing framework
- **Testing Library**: React testing utilities
- **Cypress Real Events**: Simulate real user interactions
- **Coverage**: Code coverage reporting with c8

## Test Types

### 1. Unit Tests (Vitest)

Location: `src/**/*.test.{ts,tsx}`

Unit tests focus on testing individual functions, hooks, and utilities in isolation.

```typescript
// Example: src/hooks/__tests__/use-agent-update.test.tsx
describe('useAgentUpdate hook', () => {
  test('should update agent fields correctly', () => {
    // Test implementation
  });
});
```

### 2. Component Tests (Cypress)

Location: `src/**/*.cy.{ts,tsx}`

Component tests verify that React components render correctly and handle interactions properly.

```typescript
// Example: src/components/ui/button.cy.tsx
describe('Button Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<Button>Click me</Button>);
    cy.get('[data-slot="button"]').should('exist');
  });
});
```

### 3. E2E Tests (Cypress)

Location: `cypress/e2e/**/*.cy.ts`

E2E tests simulate real user workflows across multiple pages and features.

```typescript
// Example: cypress/e2e/01-home-page.cy.ts
describe('Home Page', () => {
  it('loads successfully', () => {
    cy.visit('/');
    cy.waitForApp();
  });
});
```

## Running Tests

### Quick Start

```bash
# Install dependencies
bun install

# Run all tests
bun run test:all

# Run specific test types
bun test                    # Unit tests only
bun run cy:component       # Component tests only
bun run cy:e2e            # E2E tests only
```

### With Backend Server

For E2E tests that require the backend:

```bash
# Run all tests with server
bun run test:with-server

# Run specific test types with server
bun run test:with-server:unit
bun run test:with-server:component
bun run test:with-server:e2e
```

### Interactive Mode

```bash
# Open Cypress Test Runner
bun run cy:open

# Open Cypress for component tests
bun run cy:open:component

# Open Cypress for E2E tests
bun run cy:open:e2e

# Watch mode for unit tests
bun run test:watch
```

### Coverage Reports

```bash
# Run tests with coverage
bun test --coverage

# View coverage report
open coverage/index.html
```

## Writing Tests

### Component Test Example

```typescript
import React from 'react';
import { Button } from './button';

describe('Button Component', () => {
  it('handles click events', () => {
    const onClick = cy.stub();
    
    cy.mount(<Button onClick={onClick}>Click me</Button>);
    
    cy.get('[data-slot="button"]').click();
    cy.wrap(onClick).should('have.been.calledOnce');
  });
});
```

### E2E Test Example

```typescript
describe('Chat Functionality', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.waitForApp();
  });

  it('can send a message', () => {
    cy.get('[data-testid="chat-input"]').type('Hello!');
    cy.get('[data-testid="send-button"]').click();
    cy.get('[data-testid="chat-messages"]').should('contain', 'Hello!');
  });
});
```

### Using Test Utilities

```typescript
import { generateMockAgent, setupCommonIntercepts } from '../support/test-utils';

describe('Agent Management', () => {
  beforeEach(() => {
    setupCommonIntercepts();
  });

  it('creates new agent', () => {
    const mockAgent = generateMockAgent({ name: 'Test Agent' });
    // Use mock agent in test
  });
});
```

## Test Structure

```
packages/client/
├── cypress/
│   ├── e2e/                    # E2E test files
│   ├── fixtures/               # Test data files
│   ├── support/                # Custom commands and utilities
│   │   ├── commands.ts         # Custom Cypress commands
│   │   ├── component.ts        # Component test setup
│   │   ├── e2e.ts             # E2E test setup
│   │   └── test-utils.ts      # Shared test utilities
│   └── tsconfig.json          # TypeScript config for Cypress
├── src/
│   ├── components/
│   │   └── *.cy.tsx           # Component tests
│   └── hooks/
│       └── __tests__/         # Unit tests
└── scripts/
    └── test-with-server.sh    # Test runner script
```

## Best Practices

### 1. Use Data Attributes for Testing

Always use `data-testid` attributes for test selectors:

```typescript
// Component
<button data-testid="submit-button">Submit</button>

// Test
cy.get('[data-testid="submit-button"]').click();
```

### 2. Mock External Dependencies

```typescript
// Mock API responses
cy.intercept('GET', '/api/agents', { fixture: 'agents.json' });

// Mock WebSocket
mockWebSocket.setup();
```

### 3. Keep Tests Independent

Each test should be able to run independently:

```typescript
beforeEach(() => {
  cy.cleanupTestData();
  cy.visit('/');
});
```

### 4. Use Descriptive Test Names

```typescript
// Good
it('displays error message when agent creation fails due to invalid name')

// Bad
it('test error')
```

### 5. Test User Workflows, Not Implementation

Focus on what users do, not how the code works:

```typescript
// Good
it('user can send a message in chat')

// Bad
it('useState hook updates message state')
```

## CI/CD Integration

Tests run automatically on:

- Every push to `main` or `develop` branches
- Every pull request affecting client code

GitHub Actions workflow features:

- Matrix testing across Node versions
- Parallel test execution
- Artifact upload on failure
- Coverage reporting to Codecov
- Visual regression testing on PRs

## Troubleshooting

### Common Issues

1. **Tests fail with "Cannot find module"**
   ```bash
   # Clear cache and reinstall
   rm -rf node_modules
   bun install
   ```

2. **Cypress not found**
   ```bash
   # Install Cypress binaries
   npx cypress install
   ```

3. **Server connection errors in E2E tests**
   ```bash
   # Ensure backend is running
   cd ../server && bun run dev
   ```

4. **Component styles not loading**
   - Ensure `@/index.css` is imported in `cypress/support/component.ts`

### Debugging Tests

```typescript
// Add debug commands
cy.debug();
cy.pause();

// Take screenshots
cy.screenshot('debug-state');

// Log to console
cy.log('Current state:', someVariable);
```

### Running Single Tests

```bash
# Run specific test file
cypress run --spec "cypress/e2e/01-home-page.cy.ts"

# Run tests matching pattern
cypress run --spec "**/*chat*.cy.ts"
```

## Next Steps

1. Add more component tests for remaining components
2. Implement visual regression testing
3. Add accessibility tests with cypress-axe
4. Set up performance testing
5. Create test data factories for complex scenarios

For more information, see the [Cypress documentation](https://docs.cypress.io) and [Vitest documentation](https://vitest.dev). 