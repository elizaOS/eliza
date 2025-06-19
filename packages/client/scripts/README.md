# Test Scripts

## Main Test Script

### `test-all.sh`

The comprehensive test suite that runs everything:

1. **TypeScript Type Checking** - Validates all TypeScript types
2. **Vitest Unit Tests** - Runs unit tests with coverage
3. **ElizaOS Core Tests** - Runs the core ElizaOS test suite
4. **Cypress Component Tests** - Tests individual UI components
5. **E2E Tests with Servers** - Starts backend and frontend servers, then runs E2E tests

Run with: `bun run test`

## Quick Test Script

### `test-quick.sh`

A faster test suite for development that runs:

1. TypeScript type checking
2. Unit tests only

Run with: `bun run test:quick`

## E2E Test Script

### `test-e2e-with-server.sh`

Runs only E2E tests with automatic server management:

1. Starts the development server
2. Waits for it to be ready
3. Runs E2E tests
4. Cleans up

Run with: `bun run test:e2e:with-server`

## Individual Test Commands

- `bun run test:unit` - Run only unit tests
- `bun run test:component` - Run only component tests
- `bun run test:e2e` - Run only E2E tests (requires servers to be running)
- `bun run cypress:open` - Open Cypress interactive test runner
- `bun run type-check` - Run only TypeScript type checking
