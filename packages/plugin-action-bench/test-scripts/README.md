# Plugin Action Bench - Performance Testing Framework

This directory contains a comprehensive performance testing framework for the ElizaOS Plugin Action Bench system. It measures response times, calculates performance metrics (P50, P95, P99), and validates that the AI agent correctly executes benchmark actions.

## Features

- **WebSocket-based Testing**: Direct socket connection to ELIZA server for real-time testing
- **Performance Metrics**: Automated calculation of P50, P95, P99, mean, and standard deviation
- **Response Validation**: Pattern matching and action verification for each test
- **Multiple Benchmark Categories**: Tests for Typewriter, Multiverse Math, and Relational Data operations
- **Configurable Test Runs**: Run each prompt multiple times for statistical significance
- **Warmup Phase**: Prime the system before actual testing
- **Detailed Reporting**: Visual performance reports with histograms and threshold checking
- **Result Persistence**: Save test results to JSON for later analysis

## Installation

```bash
# From the test-scripts directory
npm install

# Or using bun
bun install
```

## Quick Start

### 1. Start ELIZA Server

First, ensure your ELIZA server is running with the plugin-action-bench loaded:

```bash
# From your ELIZA project
elizaos start
```

### 2. Run All Benchmarks

```bash
npm test
# or
npx tsx index.ts all
```

### 3. Run Specific Category

```bash
# Typewriter benchmarks only
npm run test:typewriter

# Multiverse Math benchmarks only
npm run test:math

# Relational Data benchmarks only
npm run test:relational
```

### 4. Run with Verbose Output

```bash
npm run test:verbose
# or
npx tsx index.ts all --verbose
```

## Configuration

### Environment Variables

Configure the test behavior using environment variables:

```bash
# Server connection
ELIZA_SERVER_URL=ws://localhost:3000  # WebSocket URL for ELIZA server

# Test categories (set to false to disable)
TEST_TYPEWRITER=true           # Enable typewriter tests
TEST_MULTIVERSE_MATH=true      # Enable multiverse math tests
TEST_RELATIONAL_DATA=true      # Enable relational data tests

# Output settings
VERBOSE=true                   # Show detailed output

# Agent configuration
AGENT_ID=default               # Agent ID to test against
```

### Configuration File

Edit `config.ts` for more detailed settings:

```typescript
export const config = {
  server: {
    url: "ws://localhost:3000",
    reconnectAttempts: 3,
    reconnectDelay: 1000,
  },
  test: {
    defaultTimeout: 5000,        // Response timeout in ms
    delayBetweenPrompts: 500,    // Delay between test prompts
    warmupPrompts: 3,            // Number of warmup prompts
    runsPerPrompt: 10,           // Times to run each prompt
  },
  thresholds: {
    p50: 1000,                   // P50 threshold in ms
    p95: 3000,                   // P95 threshold in ms
    p99: 5000,                   // P99 threshold in ms
    successRate: 0.95,           // Required success rate
  },
};
```

## Test Structure

### Typewriter Tests

Tests rapid action chaining with single-letter typing actions:

- Single letter tests (a, z)
- Short words (hello, world, test)
- Medium words (benchmark, performance)
- Long sequences (alphabet, phrases)
- Repeated letters (aaa, mississippi)
- Sequential typing with state accumulation

### Multiverse Math Tests

Tests context-dependent mathematical operations across dimensions:

- Number input (0-9 digit entry)
- Dimension selection (quantum, chaos, prime, etc.)
- Basic operations (add, subtract, multiply, divide)
- Special operations (modulo, power, square root)
- Dimension-specific behaviors
- Complex calculation chains
- Memory operations (store, recall, clear)

### Relational Data Tests

Tests entity-relationship graph management:

- Entity creation (person, company, product)
- Entity selection and attribute management
- Relationship creation (employment, sibling, ownership)
- Query operations (by type, by attribute)
- Path finding between entities
- Graph statistics
- Delete operations
- Complex scenarios (org structures, family trees)

## Output Format

### Performance Metrics Report

```
╔════════════════════════════════════════════════════════════╗
║ Performance Metrics: Typewriter                           ║
╠════════════════════════════════════════════════════════════╣
║ Total Tests:     180                                      ║
║ Successful:      171                                      ║
║ Failed:          9                                         ║
║ Success Rate:    95.0%                                     ║
╠════════════════════════════════════════════════════════════╣
║ Response Times (ms):                                       ║
║   P50 (median):  234.50                                   ║
║   P95:           892.35                                   ║
║   P99:           1823.99                                  ║
║   Mean:          312.45                                   ║
║   Min:           123.00                                   ║
║   Max:           2341.00                                  ║
║   Std Dev:       234.56                                   ║
╚════════════════════════════════════════════════════════════╝
```

### Response Time Distribution

```
Response Time Distribution:
────────────────────────────────────────────────────────────
  100-  200 ms │ ████████████████████████████████████████ │ 45
  200-  300 ms │ ██████████████████████████████           │ 32
  300-  400 ms │ ████████████████████                     │ 21
  400-  500 ms │ ████████████                             │ 15
  500-  600 ms │ ████████                                 │ 10
  600-  700 ms │ ████                                     │ 5
  700-  800 ms │ ██                                       │ 3
  800-  900 ms │ ██                                       │ 2
  900- 1000 ms │ █                                        │ 1
 1000- 1100 ms │ █                                        │ 1
```

## Test Results

Results are automatically saved to `test-results/benchmark-{timestamp}.json`:

```json
{
  "sessionId": "bench-1704067200000",
  "startTime": 1704067200000,
  "endTime": 1704067800000,
  "results": [
    {
      "promptId": "typewriter-hello",
      "prompt": "type hello",
      "success": true,
      "responseTime": 234,
      "response": "I've typed: hello",
      "matchedPatterns": ["hello", "typed: hello"],
      "timestamp": 1704067200234
    }
  ],
  "metrics": [
    {
      "category": "Typewriter",
      "totalTests": 180,
      "successfulTests": 171,
      "failedTests": 9,
      "p50": 234.5,
      "p95": 892.35,
      "p99": 1823.99,
      "mean": 312.45,
      "min": 123,
      "max": 2341,
      "stdDev": 234.56
    }
  ]
}
```

## Adding New Tests

### 1. Add Test Prompts

Create or edit files in `prompts/`:

```typescript
// prompts/custom.ts
export const customPrompts: TestPrompt[] = [
  {
    id: "custom-test-1",
    category: "typewriter", // or "multiverse-math" or "relational-data"
    prompt: "your test prompt here",
    expectedPatterns: ["pattern1", "pattern2"],
    expectedActions: ["ACTION_NAME"],
    timeout: 5000, // optional custom timeout
    setup: [      // optional setup prompts
      {
        id: "setup-1",
        category: "typewriter",
        prompt: "setup prompt",
        expectedPatterns: ["setup complete"],
        expectedActions: ["SETUP_ACTION"],
      }
    ],
  }
];
```

### 2. Import in Runner

Add your prompts to the appropriate category in `runner.ts`.

## Troubleshooting

### Connection Issues

```bash
# Check if ELIZA server is running
curl http://localhost:3000/health

# Test WebSocket connection
wscat -c ws://localhost:3000

# Check server URL configuration
echo $ELIZA_SERVER_URL
```

### Timeout Issues

Increase timeouts in `config.ts`:
```typescript
test: {
  defaultTimeout: 10000,  // Increase to 10 seconds
}
```

Or set custom timeout per prompt:
```typescript
{
  id: "slow-test",
  prompt: "complex operation",
  timeout: 15000,  // 15 seconds for this specific test
}
```

### Failed Tests

Run with verbose mode to see detailed error messages:
```bash
npm run test:verbose
```

Check the saved results file for full error details:
```bash
cat test-results/benchmark-*.json | jq '.results[] | select(.success == false)'
```

## Performance Optimization Tips

1. **Reduce Runs Per Prompt**: For quick testing, reduce `runsPerPrompt` in config
2. **Disable Categories**: Use environment variables to test specific categories only
3. **Skip Warmup**: Set `warmupPrompts: 0` in config for faster starts
4. **Increase Delays**: If seeing rate limiting, increase `delayBetweenPrompts`

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Benchmark Tests
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: |
          cd plugin-action-bench/test-scripts
          npm install
      
      - name: Start ELIZA server
        run: |
          elizaos start &
          sleep 10  # Wait for server to start
      
      - name: Run benchmarks
        run: |
          cd plugin-action-bench/test-scripts
          npm test
        env:
          ELIZA_SERVER_URL: ws://localhost:3000
      
      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: benchmark-results
          path: plugin-action-bench/test-scripts/test-results/
```

## Development

### Project Structure

```
test-scripts/
├── index.ts              # Main entry point
├── runner.ts             # Test orchestration
├── socket-client.ts      # WebSocket client
├── config.ts             # Configuration
├── types.ts              # TypeScript types
├── validation.ts         # Response validation
├── performance-metrics.ts # Metrics calculation
├── prompts/              # Test definitions
│   ├── typewriter.ts
│   ├── multiverse-math.ts
│   └── relational-data.ts
├── test-results/         # Saved test results
└── package.json          # Dependencies
```

### Contributing

1. Add new test prompts to appropriate files in `prompts/`
2. Ensure expected patterns and actions are accurate
3. Test locally before submitting
4. Include performance baseline in PR description

## License

Part of the ElizaOS Plugin Action Bench system.
