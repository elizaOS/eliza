# MongoDB Adapter for ElizaOS

## Purpose

A robust MongoDB adapter for ElizaOS that provides persistence, vector search capabilities, and caching functionality.

## Key Features

- Full MongoDB database support with connection pooling
- Vector search capabilities for efficient similarity searches
- Automatic fallback to standard search when vector search is unavailable
- Built-in caching system with TTL support
- Sharding support for better performance at scale
- Comprehensive memory and knowledge management
- Relationship tracking between users
- Goal tracking and management
- Participant and room management

## Installation

```bash
bun install @elizaos-plugins/adapter-mongodb
```

## Configuration

Add the adapter to your ElizaOS configuration:

```json
{
  "plugins": ["@elizaos-plugins/adapter-mongodb"],
  "settings": {
    "MONGODB_CONNECTION_STRING": "your_mongodb_connection_string",
    "MONGODB_DATABASE": "your_database_name" // Optional, defaults to "elizaAgent"
  }
}
```

### Required Environment Variables

- `MONGODB_CONNECTION_STRING`: Your MongoDB connection string
- `MONGODB_DATABASE` (optional): Database name to use

## Integration

The adapter provides persistence, vector search, and caching functionality for ElizaOS through MongoDB.

## Example Usage

```bash
cd src/__tests__
./run_tests.sh
```
