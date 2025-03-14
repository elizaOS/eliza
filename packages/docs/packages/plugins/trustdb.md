# @elizaos/plugin-trustdb

A plugin for managing trust scores and performance metrics in a secure database, providing recommender tracking and token performance analysis capabilities.

## Overview

This plugin provides functionality to:

- Track and manage recommender trust scores
- Monitor token performance metrics
- Record and analyze trading performance
- Maintain historical metrics data
- Handle transaction records and validations

## Installation

```bash
npm install @elizaos/plugin-trustdb
```

## Configuration

The plugin uses SQLite as its database backend and requires proper initialization:

```typescript
import { TrustScoreDatabase } from "@elizaos/plugin-trustdb";
import Database from "better-sqlite3";

const db = new Database("path/to/database.sqlite");
const trustDB = new TrustScoreDatabase(db);
```

## Usage

Import and use the TrustDB functionality in your application:

```typescript
import { TrustScoreDatabase } from "@elizaos/plugin-trustdb";

// Initialize database
const trustDB = new TrustScoreDatabase(db);

// Add a recommender
const recommender = {
    id: "uuid",
    address: "wallet-address",
    telegramId: "telegram-id",
};
trustDB.addRecommender(recommender);

// Track token performance
const performance = {
    tokenAddress: "token-address",
    priceChange24h: 10.5,
    volumeChange24h: 25.3,
    // ... other metrics
};
trustDB.upsertTokenPerformance(performance);
```

## Features

### TrustScoreDatabase

The main database manager providing comprehensive tracking and analysis:

```typescript
// Get or create a recommender
const recommender = await trustDB.getOrCreateRecommender({
    address: "wallet-address",
    telegramId: "user-id",
});

// Update recommender metrics
trustDB.updateRecommenderMetrics({
    recommenderId: "uuid",
    trustScore: 85.5,
    totalRecommendations: 10,
    // ... other metrics
});
```

### Performance Tracking

```typescript
// Add trade performance
trustDB.addTradePerformance(
    {
        token_address: "address",
        recommender_id: "uuid",
        buy_price: 1.0,
        // ... other trade details
    },
    false
);

// Get token performance
const tokenMetrics = trustDB.getTokenPerformance("token-address");
```

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

### Linting

```bash
npm run lint
```

## Dependencies

- `better-sqlite3`: SQLite database interface
- `uuid`: Unique identifier generation
- `dompurify`: HTML sanitization
- Other standard dependencies listed in package.json

## API Reference

### Core Interfaces

```typescript
interface Recommender {
    id: string;
    address: string;
    solanaPubkey?: string;
    telegramId?: string;
    discordId?: string;
    twitterId?: string;
    ip?: string;
}

interface RecommenderMetrics {
    recommenderId: string;
    trustScore: number;
    totalRecommendations: number;
    successfulRecs: number;
    avgTokenPerformance: number;
    riskScore: number;
    consistencyScore: number;
    virtualConfidence: number;
    lastActiveDate: Date;
    trustDecay: number;
    lastUpdated: Date;
}

interface TokenPerformance {
    tokenAddress: string;
    symbol: string;
    priceChange24h: number;
    volumeChange24h: number;
    // ... other performance metrics
}
```

### Database Methods

- `addRecommender`: Add new recommender to database
- `getRecommenderMetrics`: Retrieve recommender performance metrics
- `updateRecommenderMetrics`: Update recommender metrics
- `upsertTokenPerformance`: Add or update token performance
- `getTokenPerformance`: Retrieve token performance metrics
- Many more specialized methods for tracking and analysis

## Common Issues/Troubleshooting

### Issue: Database Connection Errors

- **Cause**: Incorrect database path or permissions
- **Solution**: Verify database path and file permissions

### Issue: Data Consistency

- **Cause**: Concurrent database access
- **Solution**: Use proper transaction handling

## Security Best Practices

- Implement proper database backup procedures
- Use parameterized queries to prevent SQL injection
- Validate all input data before storage
- Maintain regular database maintenance
- Keep dependencies updated for security patches

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3): High-performance SQLite3 driver
- [uuid](https://github.com/uuidjs/uuid): UUID generation
- [DOMPurify](https://github.com/cure53/DOMPurify): HTML sanitization library

Special thanks to:

- The better-sqlite3 team for their excellent database driver
- The UUID.js maintainers for reliable identifier generation
- The DOMPurify team for security-focused sanitization tools
- The Eliza community for their contributions and feedback

For more information about database management and security:

- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [Database Security Best Practices](https://www.sqlite.org/security.html)
- [Data Sanitization Guide](https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
