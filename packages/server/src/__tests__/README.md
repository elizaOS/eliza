# Server Package Tests

This directory contains comprehensive tests for the `@elizaos/server` package.

## Test Structure

### 1. **Basic Functionality Tests** (`basic-functionality.test.ts`)

- ✅ **Working** - Core logic tests without external dependencies
- Tests path utilities, UUID validation, security patterns
- Tests rate limiting concepts and middleware patterns
- Tests server configuration logic

### 2. **Validation Tests** (`validation.test.ts`)

- ⚠️ **Needs dependency resolution** - Tests validation functions with mocking
- Tests `validateChannelId`, `validateAgentId`, etc.
- Tests security logging and pattern detection
- Tests error handling for various input types

### 3. **Middleware Tests** (`middleware.test.ts`)

- ⚠️ **Needs dependency resolution** - Tests middleware functions
- Tests `agentExistsMiddleware`, `validateUuidMiddleware`
- Tests security middleware and rate limiting
- Tests content type validation

### 4. **AgentServer Integration Tests** (`agent-server.test.ts`)

- ⚠️ **Needs dependency resolution** - Full AgentServer class tests
- Tests server initialization and lifecycle
- Tests agent registration and management
- Tests database operations and error handling

### 5. **API Endpoint Tests** (`api.test.ts`)

- ⚠️ **Needs supertest dependency** - HTTP endpoint integration tests
- Tests health check, agent, and channel endpoints
- Tests security headers and CORS
- Tests authentication and error handling

### 6. **Utility Tests** (`utils.test.ts`)

- ⚠️ **Needs mocking fixes** - Tests utility functions
- Tests `expandTildePath` and `resolvePgliteDir`
- Tests path security and environment handling

## Running Tests

### Run All Working Tests

```bash
bun test test/basic-functionality.test.ts
```

### Run All Tests (some may fail due to dependencies)

```bash
npm test
```

### Run with Coverage

```bash
bun test --coverage
```

### Watch Mode

```bash
bun test --watch test/basic-functionality.test.ts
```

## Test Categories

### ✅ **Unit Tests**

- Individual function testing
- Logic validation without dependencies
- Security pattern detection
- Configuration handling

### ⚠️ **Integration Tests**

- Full server functionality
- Database integration
- HTTP endpoint testing
- Middleware chain testing

### 🔧 **Mocking Strategy**

- Mock external dependencies (`@elizaos/core`, `@elizaos/plugin-sql`)
- Mock file system operations
- Mock HTTP requests/responses
- Mock database operations

## Dependencies Needed for Full Test Suite

```bash
npm install --save-dev supertest @types/supertest
```

## Test Coverage Goals

- **Target**: 80%+ code coverage
- **Focus Areas**:
  - Validation functions (100%)
  - Security middleware (90%+)
  - Core server functionality (85%+)
  - Error handling (90%+)

## Security Testing

The tests include comprehensive security validation:

1. **Input Validation**

   - UUID format checking
   - Suspicious pattern detection
   - Path traversal prevention

2. **Injection Prevention**

   - Script injection detection
   - SQL injection pattern recognition
   - XSS attempt identification

3. **Rate Limiting**
   - Brute force protection
   - API abuse prevention
   - Channel validation limiting

## Known Issues

1. **Workspace Dependencies**: Some tests fail due to workspace dependency resolution
2. **Mock Complexity**: Complex mocking required for database operations
3. **Integration Challenges**: Full server initialization requires extensive mocking

## Improvements Needed

1. Fix workspace dependency issues
2. Simplify mocking strategy
3. Add more edge case tests
4. Implement performance tests
5. Add end-to-end testing scenarios

## Test Philosophy

The testing approach prioritizes:

1. **Security First**: Comprehensive security validation
2. **Independent Testing**: Tests that can run without complex setup
3. **Real-world Scenarios**: Tests that reflect actual usage patterns
4. **Error Coverage**: Thorough error condition testing
