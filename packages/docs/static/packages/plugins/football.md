# @elizaos/plugin-football

## Purpose

A plugin providing live football match data and league standings integration for ElizaOS agents.

## Key Features

1. Live Match Data - Retrieves teams, scores, and game events with real-time updates
2. League Standings - Fetches team rankings, points, goals scored, and other statistics
3. Flexible Integration - Extendable for additional football data

## Installation

```bash
bun install @elizaos/plugin-football
```

## Configuration

Requires an API key from Football-Data.org, added to your `.env` file:

```env
FOOTBALL_API_KEY=your_api_key_here
```

## Integration

Provides actions (`fetchMatchAction` and `fetchStandingsAction`) that enable ElizaOS agents to access football data in conversations.

## Example Usage

```javascript
import { fetchMatchAction } from '@elizaos/plugin-football';

const result = await fetchMatchAction.handler(runtime, message, state);
console.log(result);
```

## Links

- [Football-Data.org API](https://www.football-data.org/)
- [Football-Data API Documentation](https://www.football-data.org/documentation/quickstart)
