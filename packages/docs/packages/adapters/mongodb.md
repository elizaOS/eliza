# MongoDB Adapter for ElizaOS

A robust MongoDB adapter for ElizaOS that provides persistence, vector search capabilities, and caching functionality.

## Features

- Full MongoDB database support with connection pooling
- Vector search capabilities for efficient similarity searches
- Automatic fallback to standard search when vector search is unavailable
- Built-in caching system with TTL support
- Sharding support for better performance at scale
- Comprehensive memory and knowledge management
- Relationship tracking between users
- Goal tracking and management
- Participant and room management

## Prerequisites

- MongoDB 6.0 or later (recommended for vector search support)
- NodeJS 16.0 or later
- ElizaOS installation

## Installation

```bash
npm install @elizaos-plugins/adapter-mongodb
```

## Configuration

Add the adapter to your ElizaOS configuration:

```json
{
  "plugins": ["@elizaos-plugins/adapter-mongodb"],
  "settings": {
    "MONGODB_CONNECTION_STRING": "your_mongodb_connection_string",
    "MONGODB_DATABASE": "your_database_name"  // Optional, defaults to "elizaAgent"
  }
}
```

### Required Environment Variables

- `MONGODB_CONNECTION_STRING`: Your MongoDB connection string
- `MONGODB_DATABASE` (optional): Database name to use

## Connection Options

The adapter is configured with optimal connection settings:

- Maximum pool size: 100 connections
- Minimum pool size: 5 connections
- Connection timeout: 10 seconds
- Socket timeout: 45 seconds
- Retry support for both reads and writes
- Compression enabled (zlib)

## Features in Detail

### Vector Search

The adapter automatically detects and enables vector search capabilities if your MongoDB instance supports it. This provides efficient similarity searches for:

- Memory retrieval
- Knowledge base searches
- Semantic similarity matching

If vector search is unavailable, the adapter automatically falls back to standard search methods.

### Caching

Built-in caching system with:

- 24-hour TTL by default
- Automatic cache invalidation
- Memory-efficient storage
- Cache hit/miss optimizations

### Memory Management

Comprehensive memory management features:

- CRUD operations for memories
- Vector-based similarity search
- Batch processing support
- Automatic uniqueness checking

### Knowledge Base

Robust knowledge base management:

- Support for shared and private knowledge
- Vector-based knowledge retrieval
- Metadata support
- Chunk management for large content

## Development

### Running Tests

The test suite uses Docker for running a test MongoDB instance:

```bash
cd src/__tests__
./run_tests.sh
```

This will:
1. Start a MongoDB container
2. Run the test suite
3. Clean up resources automatically

### Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## Error Handling

The adapter includes comprehensive error handling:

- Connection failure recovery
- Automatic reconnection
- Graceful degradation of vector search
- Detailed error logging

## Performance Considerations

- Uses connection pooling for optimal performance
- Implements efficient batch processing
- Supports sharding for horizontal scaling
- Includes index optimization

