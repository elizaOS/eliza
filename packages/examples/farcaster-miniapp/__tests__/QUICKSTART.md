# 🧪 Testing Quick Start

## Installation

```bash
cd /root/spartan-07-22-neo/packages/multichain-miniapp

# Install testing dependencies
npm install
```

## Running Tests

### All Tests
```bash
npm test
```

### Watch Mode (for development)
```bash
npm test -- --watch
```

### UI Mode (interactive)
```bash
npm run test:ui
```

### Coverage Report
```bash
npm run test:coverage
```

### E2E Tests Only
```bash
npm run test:e2e
```

### Specific Test File
```bash
npm test -- __tests__/api/endpoints.test.ts
```

## Test Output

You should see:
```
✓ API Endpoints (8 tests)
  ✓ Health Check
  ✓ Chains
  ✓ Portfolio
  ✓ Swap
  ✓ Bridge
  ✓ Social
  ✓ AI Chat

✓ Components (12 tests)
  ✓ App Component
  ✓ MultiChainPortfolio
  ✓ TokenSwap

✓ Integration (5 tests)
  ✓ Complete Trading Flow
  ✓ Cross-Chain Bridge Flow
  ✓ AI Chat Interaction
  ✓ Error Recovery
  ✓ Multi-Chain Operations

Test Files: 5 passed (5)
Tests: 25 passed (25)
```

## Debugging Failed Tests

1. **Check console output** for error messages
2. **Run in UI mode**: `npm run test:ui` for interactive debugging
3. **Run single test**: `npm test -- -t "test name"`
4. **Increase timeout**: Edit `vitest.config.ts` if tests timeout

## Common Issues

### Tests failing with "Cannot find module"
```bash
# Reinstall dependencies
rm -rf node_modules
npm install
```

### Tests timeout
- Check backend is not running during tests (conflicts with mocks)
- Increase `testTimeout` in `vitest.config.ts`

### Mock not working
- Ensure `setupFetchMock()` is called in `beforeEach`
- Check console for actual vs expected URLs

## Next Steps

1. ✅ All tests passing? Great!
2. 📊 Check coverage: `npm run test:coverage`
3. 🔨 Ready to build: `npm run build`
4. 🚀 Ready to deploy!

