# @mediar-ai/kv

A lightweight, pluggable Key-Value store for ComputerUse workflows. This package enables state sharing between concurrent workflow executions, allowing for coordination, locking, and progress tracking.

## Features

*   **Pluggable Backends**: Switch between Redis (production), File-system (local persistence), and Memory (testing) without changing code.
*   **Unified API**: Simple `get`, `set`, `del` API inspired by Vercel KV / Redis.
*   **Atomic Operations**: Supports `NX` (Not Exists) and `XX` (Already Exists) for locking.
*   **Zero Config**: Defaults to a local file-based store if no configuration is provided.

## Installation

```bash
npm install @mediar-ai/kv
```

## Usage

### Basic Example

```typescript
import { kv } from '@mediar-ai/kv';

async function main() {
  // Set a value
  await kv.set('user:123', 'Alice');

  // Get a value
  const user = await kv.get('user:123');
  console.log(user); // 'Alice'

  // Atomic Lock (useful for preventing race conditions)
  const acquired = await kv.set('lock:resource:A', 'locked', { nx: true, ex: 60 });
  
  if (acquired) {
    try {
      console.log('Lock acquired, doing work...');
    } finally {
      await kv.del('lock:resource:A');
    }
  } else {
    console.log('Could not acquire lock.');
  }
}
```

### List Operations (Queues)

```typescript
await kv.lpush('queue:invoices', 'inv_001', 'inv_002');
const nextItem = await kv.rpop('queue:invoices');
```

### Hash Operations

```typescript
await kv.hset('invoice:inv_001', {
  status: 'processing',
  amount: 100.50,
  vendor: 'Acme Corp'
});

const status = await kv.hget('invoice:inv_001', 'status');
const allData = await kv.hgetall('invoice:inv_001');
```

## Configuration

The client automatically detects the configuration based on environment variables or defaults.

### Environment Variables

Set `KV_URL` or `REDIS_URL` to configure the backend.

*   **Redis**: `redis://localhost:6379`
*   **File**: `file://./my-db.json`
*   **Memory**: `memory://`

### Manual Initialization

You can also create a custom client instance:

```typescript
import { createClient } from '@mediar-ai/kv';

// Redis
const redisKv = createClient({ url: 'redis://user:pass@host:6379' });

// File (Persistent local JSON file)
const fileKv = createClient({ url: 'file://./data/workflow-state.json' });

// Memory (Ephemeral, good for tests)
const memKv = createClient({ backend: 'memory' });
```

## API Reference

*   `set(key, value, { ex?, nx?, xx? })`: Set value with optional TTL (seconds) and conditions.
*   `get(key)`: Get string value.
*   `del(key)`: Delete key.
*   `expire(key, seconds)`: Set expiry on existing key.
*   `incr(key)`: Increment integer value.
*   `lpush(key, ...elements)`: Prepend to list.
*   `rpush(key, ...elements)`: Append to list.
*   `lpop(key)`: Remove and return first element.
*   `rpop(key)`: Remove and return last element.
*   `hset(key, field, value)` or `hset(key, object)`: Set hash fields.
*   `hget(key, field)`: Get hash field.
*   `hgetall(key)`: Get all fields in hash.
*   `hincrby(key, field, increment)`: Increment hash field.

## License

MIT