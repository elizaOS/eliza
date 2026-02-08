# @elizaos/plugin-bootstrap

Core event handlers, services, actions, providers and functionality for ElizaOS agents.

## Overview

This plugin provides the foundational capabilities that most agents need:

- **Actions:** Reply, send messages, manage entities, update roles, generate images
- **Providers:** Character info, entities, facts, relationships, recent messages, world/room data, time
- **Evaluators:** Reflection (fact extraction, relationship tracking)
- **Services:** Task management, embedding generation
- **Events:** Message handling, entity management, action notifications

## Key Features

### 🚀 Performance Optimizations

- **Two-Level Caching System:** Agent-specific + cross-agent caching with TTL
- **Promise Coalescing:** Prevents duplicate in-flight requests (thundering herd protection)
- **O(1) Lookups:** Map-based entity/relationship resolution instead of O(n) find()
- **Parallel Processing:** Database operations and relationship updates run concurrently
- **Conditional Formatting:** Only formats data that will actually be used
- **Timeout Protection:** 5-second timeouts prevent database hangs

### 🛡️ Robustness

- **Null-Safety:** Defensive checks throughout (`?? []`, optional chaining)
- **Error Isolation:** Failed evaluators don't crash other evaluators
- **Detailed Logging:** Structured logs with context for debugging
- **Type Safety:** Full TypeScript interfaces, no `any` types

### 💰 Token Efficiency

- **CSV Format:** Relationships use token-efficient CSV (83% reduction)
- **Data URL Summarization:** Base64 images summarized (99.8% reduction)
- **Smart Caching:** Avoids re-fetching same data multiple times

## Installation

```bash
bun add @elizaos/plugin-bootstrap
```

## Usage

```typescript
import { bootstrapPlugin } from '@elizaos/plugin-bootstrap';

const runtime = new AgentRuntime({
    plugins: [bootstrapPlugin],
    // ... other config
});
```

## Configuration Settings

The plugin respects these runtime settings:

### Memory Control
- `DISABLE_MEMORY_CREATION` - Globally disable memory creation
- `ALLOW_MEMORY_SOURCE_IDS` - Comma-separated list of allowed message source IDs for memory creation

### Behavior
- `LIMIT_TO_LAST_MESSAGE` - Only consider the last message (for stateless bots)
- `REFLECT_ON_TIMELINE` - Enable/disable reflection evaluator

## Architecture

### Caching System

The shared caching system (`src/providers/shared-cache.ts`) provides:

1. **In-Memory TTL Cache:** 30-second default, 60-second for negative results
2. **Promise Deduplication:** Multiple simultaneous requests share the same promise
3. **Cross-Agent Sharing:** Room/World data shared across all agents
4. **Agent-Specific Caching:** Entities cached per-agent (different perspectives)

### Provider Execution Order

Providers have a `position` property that determines execution order:
1. Core providers (CHARACTER, TIME, WORLD)
2. Context providers (ENTITIES, RECENT_MESSAGES, RELATIONSHIPS)
3. Action providers (ACTIONS)
4. Meta providers (EVALUATORS)

Optimized providers can reuse cached data from earlier providers.

## Performance Impact

### Database Query Reduction
- **~60% fewer database queries** per message due to caching
- **Zero redundant queries** due to promise coalescing
- **No 80+ second hangs** due to timeout protection

### Algorithm Improvements
- **Entity lookups:** O(n) → O(1) using Maps
- **Relationship dedup:** O(n²) → O(n) using Maps
- **Relationship updates:** Sequential → Parallel (20x speedup)

### Token Savings
- **Relationships:** 83% reduction (CSV format)
- **Attachments:** 99.8% reduction (data URL summarization)
- **Examples:** 50% reduction (conditional formatting)

## Documentation

See [OPTIMIZATION_GUIDE.md](./OPTIMIZATION_GUIDE.md) for detailed explanations of:
- Why each optimization exists
- How the caching system works
- When to parallelize operations
- Type safety best practices
- Token efficiency strategies

## Development

### Build
```bash
bun run build
```

### Test
```bash
bun test
```

### Lint
```bash
bun run lint
```

## Contributing

When adding new providers or modifying existing ones:

1. **Use the shared cache** for database queries
2. **Add timeout protection** for long-running operations
3. **Invalidate caches** when data changes
4. **Use TypeScript interfaces** - no `any` types
5. **Parallelize independent operations** with `Promise.all()`
6. **Document WHYs** - explain why optimizations exist

See the OPTIMIZATION_GUIDE.md for detailed best practices.

## License

MIT
