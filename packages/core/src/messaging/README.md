# MessageBusCore

Pure JavaScript message bus for real-time messaging. Works in any environment: browser, Node.js, Bun, Deno.

## Quick Start

```typescript
import { MessageBusCore } from '@elizaos/core';

// Create a message bus
const bus = new MessageBusCore();

// Subscribe to messages
const unsubscribe = bus.subscribe('channel-123', (msg) => {
  console.log(`${msg.authorName}: ${msg.content}`);
});

// Send a message
await bus.send({
  channelId: 'channel-123',
  serverId: 'server-456',
  authorId: 'user-789',
  authorName: 'Alice',
  content: 'Hello world!',
});

// Cleanup
unsubscribe();
```

## Adapters (Dependency Injection)

Extend functionality via adapters:

```typescript
// Add localStorage persistence
bus.use({
  name: 'local-storage',
  async onMessage(message) {
    localStorage.setItem(`msg-${message.id}`, JSON.stringify(message));
  },
});

// Add Socket.io broadcasting
bus.use({
  name: 'socketio',
  async onMessage(message) {
    io.to(message.channelId).emit('message', message);
  },
});
```

## API

See type definitions in `types.ts` for complete API.
