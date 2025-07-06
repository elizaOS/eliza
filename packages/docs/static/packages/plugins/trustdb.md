# @elizaos/plugin-trustdb

## Purpose

A plugin for managing trust scores and performance metrics in a secure database, providing recommender tracking and token performance analysis capabilities.

## Key Features

- Track and manage recommender trust scores
- Monitor token performance metrics
- Record and analyze trading performance
- Maintain historical metrics data
- Handle transaction records and validations

## Installation

```bash
bun install @elizaos/plugin-trustdb
```

## Configuration

```typescript
import { TrustScoreDatabase } from '@elizaos/plugin-trustdb';
import Database from 'better-sqlite3';

const db = new Database('path/to/database.sqlite');
const trustDB = new TrustScoreDatabase(db);
```

## Example Usage

```typescript
import { TrustScoreDatabase } from '@elizaos/plugin-trustdb';

// Initialize database
const trustDB = new TrustScoreDatabase(db);

// Add a recommender
const recommender = {
  id: 'uuid',
  address: 'wallet-address',
  telegramId: 'telegram-id',
};
trustDB.addRecommender(recommender);

// Track token performance
const performance = {
  tokenAddress: 'token-address',
  priceChange24h: 10.5,
  volumeChange24h: 25.3,
  // ... other metrics
};
trustDB.upsertTokenPerformance(performance);
```
