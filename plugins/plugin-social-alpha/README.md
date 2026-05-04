# Marketplace of Trust Plugin

A sophisticated trust scoring system for ElizaOS that analyzes trading calls and calculates user trust scores based on performance metrics.

## Overview

The Marketplace of Trust plugin provides:
- **Trust Score Calculation**: Advanced algorithm that evaluates users based on profit, win rate, Sharpe ratio, and call quality
- **Trading Call Analysis**: Process Discord messages to extract and analyze trading calls
- **Price Data Enrichment**: Integrate with Birdeye and DexScreener APIs for historical price data
- **Algorithm Optimization**: Machine learning-based parameter tuning for optimal trust score accuracy
- **Leaderboard System**: Real-time trust score rankings with beautiful UI

## Architecture

```
src/
├── services/              # Core business logic
│   ├── SimulationService.ts      # Consolidated simulation functionality
│   ├── PriceDataService.ts       # Price data fetching and enrichment
│   ├── TrustScoreService.ts      # Trust score calculation and optimization
│   └── balancedTrustScoreCalculator.ts  # Core scoring algorithm
├── scripts/               # CLI tools
│   ├── process-discord-data.ts   # Process raw Discord data
│   ├── enrich-price-data.ts      # Enrich calls with price data
│   ├── analyze-trust-scores.ts   # Analyze and rank users
│   └── optimize-algorithm.ts     # Optimize scoring parameters
├── frontend/              # React UI components
│   └── LeaderboardTable.tsx      # Trust score leaderboard
└── __tests__/            # Comprehensive test suite
```

## Installation

```bash
npm install @elizaos/plugin-marketplace-of-trust
```

## Configuration

Add to your `.env` file:

```env
# API Keys (at least one required)
BIRDEYE_API_KEY=your_birdeye_api_key
DEXSCREENER_API_KEY=your_dexscreener_api_key

# Optional: Helius for token metadata
HELIUS_API_KEY=your_helius_api_key
```

## Usage

### 1. Process Discord Data

Extract trading calls from Discord export:

```bash
npm run process-discord-data -- --input ./discord-data --output ./processed-data
```

Options:
- `--input <dir>`: Directory containing Discord JSON exports (default: `./discord-data`)
- `--output <dir>`: Output directory for processed data (default: `./processed-data`)
- `--batch-size <number>`: Number of calls per batch (default: `1000`)

### 2. Enrich with Price Data

Fetch historical price data for each trading call:

```bash
npm run enrich-price-data -- --input ./processed-data/batches --output ./enriched-data
```

Options:
- `--input <dir>`: Directory containing processed batches (default: `./processed-data/batches`)
- `--output <dir>`: Output directory for enriched data (default: `./enriched-data`)
- `--resume`: Resume from previous run if interrupted

### 3. Analyze Trust Scores

Calculate trust scores and generate rankings:

```bash
npm run analyze-trust-scores -- --input ./enriched-data/enriched_calls.json --output ./trust-analysis
```

Options:
- `--input <file>`: Enriched calls JSON file
- `--output <dir>`: Output directory for analysis results
- `--compare`: Compare different scoring algorithms
- `--visualize`: Generate CSV for data visualization

### 4. Optimize Algorithm (Optional)

Fine-tune scoring parameters using ML optimization:

```bash
npm run optimize-algorithm -- --quick --output ./optimization-results
```

Options:
- `--quick`: Run quick optimization with fewer parameter combinations
- `--cache`: Use cached simulation data (default: true)
- `--output <dir>`: Output directory for optimization results

## Trust Score Algorithm

The balanced trust score algorithm considers multiple factors:

```typescript
score = profitComponent * profitWeight +
        winRateComponent * winRateWeight +
        sharpeComponent * sharpeWeight +
        alphaComponent * alphaWeight +
        consistencyComponent * consistencyWeight +
        qualityComponent * qualityWeight
```

### Components:
- **Profit**: Average profit percentage across all calls
- **Win Rate**: Percentage of profitable calls
- **Sharpe Ratio**: Risk-adjusted returns
- **Alpha**: Excess returns vs market
- **Consistency**: Stability of returns
- **Quality**: Penalty for rug pull promotions

### Default Weights:
- Profit: 25%
- Win Rate: 25%
- Sharpe: 15%
- Alpha: 10%
- Consistency: 10%
- Quality: 15%

## API Integration

### Using in Your Plugin

```typescript
import { MarketplaceOfTrustService } from '@elizaos/plugin-marketplace-of-trust';

// In your plugin definition
export const myPlugin: Plugin = {
  name: 'my-plugin',
  services: [MarketplaceOfTrustService],
  // ... other plugin config
};
```

### Accessing Trust Scores

```typescript
// Get user trust score
const trustProfile = await runtime.getComponent(
  userId,
  'trust_profile',
  worldId
);

console.log(`Trust Score: ${trustProfile.data.trustScore}`);
console.log(`Total Calls: ${trustProfile.data.totalCalls}`);
console.log(`Win Rate: ${trustProfile.data.winRate}%`);
```

## Testing

Run the comprehensive test suite:

```bash
# Unit tests
npm test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:coverage
```

## Development

### Building

```bash
npm run build
```

### Development Server

```bash
npm run dev
```

### Code Quality

```bash
npm run lint
npm run format
npm run typecheck
```

## Performance Considerations

- **Caching**: The system caches simulation results and API responses to minimize redundant calls
- **Rate Limiting**: Built-in rate limiting for API calls (100ms delay between requests)
- **Batch Processing**: Processes data in configurable batches to manage memory usage
- **Resume Support**: Price enrichment can be resumed if interrupted

## Troubleshooting

### Common Issues

1. **No API Keys**: Ensure at least one price data API key is configured
2. **Rate Limits**: If hitting API rate limits, reduce batch size or add delays
3. **Memory Issues**: For large datasets, reduce batch size or process in chunks
4. **TypeScript Errors**: Run `npm run typecheck` to identify type issues

### Debug Mode

Enable debug logging:

```bash
DEBUG=marketplace-of-trust:* npm run process-discord-data
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

MIT

## Support

For issues and questions:
- GitHub Issues: [elizaos/elizaos](https://github.com/elizaos/elizaos/issues)
- Discord: [ElizaOS Community](https://discord.gg/elizaos)
