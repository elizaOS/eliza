# E2E Testing Suite

Comprehensive end-to-end tests for the Eliza Multi-Chain Mini App.

## Test Structure

```
__tests__/
├── setup.ts                    # Global test setup and mocks
├── utils/
│   └── test-helpers.ts        # Test utilities and mock data
├── api/
│   └── endpoints.test.ts      # API endpoint tests
├── components/
│   ├── App.test.tsx           # Main app component tests
│   ├── MultiChainPortfolio.test.tsx  # Portfolio tests
│   └── TokenSwap.test.tsx     # Swap component tests
└── integration/
    └── e2e.test.ts            # Full e2e workflow tests
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test -- --watch

# Run with UI
npm run test:ui

# Run with coverage
npm run test:coverage

# Run only e2e tests
npm run test:e2e

# Run specific test file
npm test -- __tests__/api/endpoints.test.ts
```

## Test Coverage

### API Tests (`api/endpoints.test.ts`)
- ✅ Health check endpoint
- ✅ Chains listing
- ✅ Multi-chain portfolio fetching
- ✅ Swap quote generation
- ✅ Swap execution
- ✅ Bridge quote generation
- ✅ Bridge execution
- ✅ Farcaster posting
- ✅ Farcaster feed fetching
- ✅ AI chat interaction
- ✅ Error handling

### Component Tests
**App Component** (`components/App.test.tsx`)
- ✅ Initial loading screen
- ✅ Authentication flow
- ✅ Navigation tabs display
- ✅ Tab switching
- ✅ Error handling

**MultiChainPortfolio** (`components/MultiChainPortfolio.test.tsx`)
- ✅ Loading state
- ✅ Portfolio data display
- ✅ Chain filtering
- ✅ Refresh functionality
- ✅ Error handling

**TokenSwap** (`components/TokenSwap.test.tsx`)
- ✅ Swap interface rendering
- ✅ Quote fetching
- ✅ Token direction swapping
- ✅ Swap execution
- ✅ Error handling

### Integration Tests (`integration/e2e.test.ts`)
- ✅ Complete trading workflow
- ✅ Cross-chain bridge flow
- ✅ AI chat interaction flow
- ✅ Error recovery flow
- ✅ Multi-chain operations

## Test Utilities

### Mock Data
- Mock JWT tokens
- Mock wallet addresses
- Mock API responses for all endpoints
- Mock Farcaster SDK

### Helper Functions
- `setupFetchMock()` - Setup API mocking
- `resetFetchMock()` - Reset mocks between tests
- `renderWithProviders()` - Render with React context
- `waitForElement()` - Wait for async elements

## Writing New Tests

### Example API Test
```typescript
it('should fetch data', async () => {
    const response = await fetch('/api/endpoint')
    const data = await response.json()
    
    expect(response.ok).toBe(true)
    expect(data).toBeDefined()
})
```

### Example Component Test
```typescript
it('should render component', async () => {
    render(<MyComponent />)
    
    await waitFor(() => {
        expect(screen.getByText(/expected text/i)).toBeInTheDocument()
    })
})
```

### Example User Interaction Test
```typescript
it('should handle click', async () => {
    const user = userEvent.setup()
    render(<MyComponent />)
    
    const button = screen.getByRole('button')
    await user.click(button)
    
    expect(/* assertion */).toBe(true)
})
```

## CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Run Tests
  run: npm test -- --run

- name: Generate Coverage
  run: npm run test:coverage

- name: Upload Coverage
  uses: codecov/codecov-action@v3
```

## Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Use `afterEach` to reset state
3. **Async**: Always use `waitFor` for async operations
4. **Descriptive**: Write clear test names
5. **Coverage**: Aim for >80% coverage
6. **Fast**: Keep tests fast (<10s per test)

## Debugging Tests

```bash
# Run single test in debug mode
npm test -- --reporter=verbose __tests__/api/endpoints.test.ts

# Open UI for interactive debugging
npm run test:ui
```

## Mock Configuration

All API calls are mocked by default. To test against real API:

1. Set `VITE_USE_REAL_API=true` in `.env.test`
2. Ensure backend is running
3. Run tests with `npm run test:real`

## Troubleshooting

**Tests timeout:**
- Increase timeout in `vitest.config.ts`
- Check for missing `await` keywords

**Mock not working:**
- Verify `setupFetchMock()` is called in `beforeEach`
- Check mock implementation matches expected URL

**Component not rendering:**
- Ensure all providers are wrapped
- Check for missing props

## Additional Resources

- [Vitest Documentation](https://vitest.dev)
- [Testing Library](https://testing-library.com)
- [React Testing Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

