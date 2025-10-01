# Message Bus Refactor: Implementation Proposal

## Summary

**Problem**: Current message bus architecture has redundant tables, tight coupling, and cannot run in browser-only mode.

**Solution**: Create a pure JavaScript `MessageBusCore` that works in any environment, with optional adapters for server/database/agent runtime.

**Impact**:

- ✅ Enables browser-only agent chat (no server needed)
- ✅ Reduces table redundancy by 50%
- ✅ Simplifies codebase by ~30%
- ✅ Backward compatible with existing deployments
- ✅ Better separation of concerns

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MessageBusCore                          │
│              (Pure JS, EventTarget-based)                   │
│                                                              │
│  API:                                                        │
│  - send(message)           → Send to channel                │
│  - subscribe(channelId)    → Listen to channel              │
│  - joinChannel(channelId)  → Join a channel                 │
│  - leaveChannel(channelId) → Leave a channel                │
│                                                              │
│  Events:                                                     │
│  - 'message'               → New message received           │
│  - 'message_complete'      → Agent finished processing      │
│  - 'control'               → UI control message             │
└─────────────────────────────────────────────────────────────┘
                              ↑
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ↓               ↓               ↓
    ┌────────────────┐ ┌────────────┐ ┌─────────────┐
    │ Database       │ │ Server     │ │ Agent       │
    │ Adapter        │ │ Adapter    │ │ Adapter     │
    │ (Optional)     │ │ (Optional) │ │ (Optional)  │
    └────────────────┘ └────────────┘ └─────────────┘
              ↓               ↓               ↓
         [Storage]    [Socket.io/REST]   [Runtime]
```

---

## Implementation: Step-by-Step

### Step 1: Create Core Message Bus (No Dependencies)

**Location**: `packages/core/src/messaging/bus-core.ts`

```typescript
/**
 * Pure JavaScript message bus that works in any environment
 * No dependencies on server, database, or agent runtime
 */

import { EventTarget } from 'node:events'; // Polyfill for browser compatibility

export interface Message {
  id: string;
  channelId: string;
  serverId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
  source?: string;
  attachments?: any[];
  metadata?: Record<string, any>;
  inReplyTo?: string;
}

export interface MessageBusAdapter {
  name: string;
  onMessage?(message: Message): Promise<void>;
  onJoin?(channelId: string, userId: string): Promise<void>;
  onLeave?(channelId: string, userId: string): Promise<void>;
}

export class MessageBusCore extends EventTarget {
  private adapters: MessageBusAdapter[] = [];
  private channelSubscribers = new Map<string, Set<(msg: Message) => void>>();
  private joinedChannels = new Set<string>();

  constructor() {
    super();
  }

  /**
   * Register an adapter (database, server, agent runtime)
   */
  use(adapter: MessageBusAdapter): void {
    this.adapters.push(adapter);
    console.log(`[MessageBusCore] Registered adapter: ${adapter.name}`);
  }

  /**
   * Send a message to a channel
   */
  async send(message: Omit<Message, 'id' | 'timestamp'>): Promise<Message> {
    const fullMessage: Message = {
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    // Emit to local subscribers first (immediate UI update)
    this.emitToSubscribers(fullMessage);

    // Pass through all adapters (database storage, socket broadcast, agent processing)
    await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onMessage?.(fullMessage);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter ${adapter.name} failed:`, error);
        }
      })
    );

    return fullMessage;
  }

  /**
   * Subscribe to messages in a channel
   */
  subscribe(channelId: string, callback: (msg: Message) => void): () => void {
    if (!this.channelSubscribers.has(channelId)) {
      this.channelSubscribers.set(channelId, new Set());
    }

    this.channelSubscribers.get(channelId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.channelSubscribers.get(channelId)?.delete(callback);
    };
  }

  /**
   * Join a channel (mark as active)
   */
  async joinChannel(channelId: string, userId: string): Promise<void> {
    this.joinedChannels.add(channelId);

    // Notify adapters
    await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onJoin?.(channelId, userId);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter ${adapter.name} join failed:`, error);
        }
      })
    );
  }

  /**
   * Leave a channel
   */
  async leaveChannel(channelId: string, userId: string): Promise<void> {
    this.joinedChannels.delete(channelId);

    // Notify adapters
    await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onLeave?.(channelId, userId);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter ${adapter.name} leave failed:`, error);
        }
      })
    );
  }

  /**
   * Check if a channel is active
   */
  isChannelJoined(channelId: string): boolean {
    return this.joinedChannels.has(channelId);
  }

  /**
   * Emit message to local subscribers
   */
  private emitToSubscribers(message: Message): void {
    const subscribers = this.channelSubscribers.get(message.channelId);
    if (subscribers) {
      subscribers.forEach((callback) => {
        try {
          callback(message);
        } catch (error) {
          console.error('[MessageBusCore] Subscriber callback error:', error);
        }
      });
    }

    // Also emit as CustomEvent for EventTarget-based listeners
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }

  /**
   * Generate unique message ID
   */
  private generateId(): string {
    // Use crypto.randomUUID if available (browser/Node 16+), otherwise fallback
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Simple fallback for older environments
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}
```

---

### Step 2: Create Database Adapter

**Location**: `packages/plugin-sql/src/adapters/message-bus-db-adapter.ts`

```typescript
import type { MessageBusAdapter, Message } from '@elizaos/core';
import type { IDatabaseAdapter } from '@elizaos/core';

export class MessageBusDbAdapter implements MessageBusAdapter {
  name = 'database';

  constructor(private db: IDatabaseAdapter) {}

  async onMessage(message: Message): Promise<void> {
    // Store message in database
    // This replaces AgentServer.createMessage() logic

    // 1. Ensure channel exists
    await this.ensureChannelExists(message.channelId, message.serverId);

    // 2. Store message in root_messages
    await this.db.createMemory({
      id: message.id as UUID,
      content: {
        text: message.content,
        source: message.source,
        attachments: message.attachments,
      },
      entityId: message.authorId as UUID,
      roomId: message.channelId as UUID, // Use channelId directly as roomId
      worldId: message.serverId as UUID, // Use serverId directly as worldId
      createdAt: message.timestamp,
    });
  }

  async onJoin(channelId: string, userId: string): Promise<void> {
    // Add participant to channel
    // This replaces the channel_participants logic

    await this.db.addParticipant({
      roomId: channelId as UUID,
      entityId: userId as UUID,
    });
  }

  async onLeave(channelId: string, userId: string): Promise<void> {
    // Remove participant from channel
    await this.db.removeParticipant({
      roomId: channelId as UUID,
      entityId: userId as UUID,
    });
  }

  private async ensureChannelExists(channelId: string, serverId: string): Promise<void> {
    // Get or create room (which represents the channel)
    const room = await this.db.getRoom(channelId as UUID);
    if (!room) {
      await this.db.createRoom({
        id: channelId as UUID,
        name: `Channel ${channelId.substring(0, 8)}`,
        source: 'message-bus',
        type: 'group', // or 'dm'
        serverId: serverId,
      });
    }
  }
}
```

---

### Step 3: Create Server Adapter (Socket.io)

**Location**: `packages/server/src/adapters/message-bus-server-adapter.ts`

```typescript
import type { MessageBusAdapter, Message } from '@elizaos/core';
import type { Server as SocketIOServer } from 'socket.io';

export class MessageBusServerAdapter implements MessageBusAdapter {
  name = 'socketio';

  constructor(private io: SocketIOServer) {}

  async onMessage(message: Message): Promise<void> {
    // Broadcast message to all connected clients in the channel
    // This replaces SocketIORouter broadcast logic

    this.io.to(message.channelId).emit('messageBroadcast', {
      id: message.id,
      senderId: message.authorId,
      senderName: message.authorName,
      text: message.content,
      channelId: message.channelId,
      roomId: message.channelId, // Backward compatibility
      serverId: message.serverId,
      createdAt: message.timestamp,
      source: message.source,
      attachments: message.attachments,
      metadata: message.metadata,
    });
  }

  async onJoin(channelId: string, userId: string): Promise<void> {
    // Socket.io room joining is handled separately by SocketIORouter
    // This is just a hook if needed
    console.log(`[ServerAdapter] User ${userId} joined channel ${channelId}`);
  }

  async onLeave(channelId: string, userId: string): Promise<void> {
    console.log(`[ServerAdapter] User ${userId} left channel ${channelId}`);
  }
}
```

---

### Step 4: Create Agent Runtime Adapter

**Location**: `packages/core/src/adapters/message-bus-agent-adapter.ts`

```typescript
import type { MessageBusAdapter, Message, IAgentRuntime } from '@elizaos/core';

export class MessageBusAgentAdapter implements MessageBusAdapter {
  name = 'agent-runtime';

  constructor(private runtime: IAgentRuntime) {}

  async onMessage(message: Message): Promise<void> {
    // Transform message to agent Memory and emit MESSAGE_RECEIVED
    // This replaces MessageBusService.handleIncomingMessage() logic

    // Get or create agent-specific room (UUID-swizzled)
    const agentRoomId = this.runtime.createUniqueUuid(message.channelId);
    const agentWorldId = this.runtime.createUniqueUuid(message.serverId);

    // Transform to Memory
    const memory: Memory = {
      id: this.runtime.createUniqueUuid(message.id),
      entityId: this.runtime.createUniqueUuid(message.authorId),
      content: {
        text: message.content,
        source: message.source,
        attachments: message.attachments,
      },
      roomId: agentRoomId,
      worldId: agentWorldId,
      agentId: this.runtime.agentId,
      createdAt: message.timestamp,
    };

    // Emit to runtime (plugin-bootstrap will handle)
    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      callback: async (responseContent: Content) => {
        // Send agent's response back through MessageBusCore
        const bus = this.runtime.getService('message-bus-core') as MessageBusCore;
        await bus.send({
          channelId: message.channelId,
          serverId: message.serverId,
          authorId: this.runtime.agentId,
          authorName: this.runtime.character.name,
          content: responseContent.text || '',
          source: 'agent',
          metadata: {
            thought: responseContent.thought,
            actions: responseContent.actions,
          },
          inReplyTo: message.id,
        });

        return [];
      },
    });
  }
}
```

---

### Step 5: Wire It Up in Server

**Location**: `packages/server/src/index.ts`

```typescript
import { MessageBusCore } from '@elizaos/core';
import { MessageBusDbAdapter } from '@elizaos/plugin-sql';
import { MessageBusServerAdapter } from './adapters/message-bus-server-adapter';
import { MessageBusAgentAdapter } from '@elizaos/core';

export class AgentServer {
  private messageBus: MessageBusCore;

  async initialize() {
    // Create core bus
    this.messageBus = new MessageBusCore();

    // Register adapters
    this.messageBus.use(new MessageBusDbAdapter(this.db));
    this.messageBus.use(new MessageBusServerAdapter(this.io));

    // Register agent adapters (one per agent)
    for (const runtime of this.elizaOS.getAgents()) {
      this.messageBus.use(new MessageBusAgentAdapter(runtime));

      // Also register bus as a service so agent can access it
      await runtime.registerService({
        serviceType: 'message-bus-core',
        instance: this.messageBus,
      });
    }

    // Replace old InternalMessageBus usage
    // OLD: internalMessageBus.emit('new_message', data)
    // NEW: messageBus.send(data)
  }
}
```

---

### Step 6: Update SocketIORouter

**Location**: `packages/server/src/socketio/index.ts`

```typescript
export class SocketIORouter {
  private async handleMessageSubmission(socket: Socket, payload: any) {
    // OLD way (multi-step):
    // 1. serverInstance.createMessage()
    // 2. internalMessageBus.emit('new_message')
    // 3. socket.emit('messageBroadcast')

    // NEW way (single step):
    const messageBus = this.serverInstance.getMessageBus();
    await messageBus.send({
      channelId: payload.channelId,
      serverId: payload.serverId,
      authorId: payload.senderId,
      authorName: payload.senderName,
      content: payload.message,
      source: payload.source || 'socketio',
      attachments: payload.attachments,
      metadata: payload.metadata,
    });

    // That's it! Adapters handle:
    // - Database storage (MessageBusDbAdapter)
    // - Socket.io broadcast (MessageBusServerAdapter)
    // - Agent processing (MessageBusAgentAdapter)
  }
}
```

---

### Step 7: Browser-Only Mode (New Feature!)

**Location**: `packages/client/src/lib/message-bus-browser.ts`

```typescript
import { MessageBusCore, type Message } from '@elizaos/core';

/**
 * Create a browser-only message bus with in-memory storage
 * No server required!
 */
export function createBrowserMessageBus() {
  const bus = new MessageBusCore();

  // Optional: Add local storage adapter for persistence
  bus.use({
    name: 'local-storage',
    async onMessage(message: Message) {
      const key = `messages:${message.channelId}`;
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      existing.push(message);
      localStorage.setItem(key, JSON.stringify(existing));
    },
  });

  return bus;
}

// Usage in frontend:
const messageBus = createBrowserMessageBus();

// Subscribe to messages
messageBus.subscribe('channel-123', (msg) => {
  console.log('New message:', msg);
  // Update UI
});

// Send message (stays local)
await messageBus.send({
  channelId: 'channel-123',
  serverId: 'local',
  authorId: 'user-1',
  authorName: 'Alice',
  content: 'Hello world!',
});

// Or connect to server:
import { MessageBusServerAdapter } from './adapters/socketio-adapter';
const socketAdapter = new MessageBusServerAdapter(socket);
messageBus.use(socketAdapter);
```

---

## Database Schema Changes

### Option 1: Minimal Changes (Recommended)

**No new tables, just document dual purpose:**

```typescript
/**
 * UNIFIED SCHEMA: rooms = channels
 *
 * The `rooms` table serves dual purpose:
 * 1. Central channels (agentId = NULL, id = channelId)
 * 2. Agent-specific rooms (agentId = set, id = agent UUID-swizzled)
 *
 * Query for central channel:
 *   SELECT * FROM rooms WHERE id = :channelId AND agentId IS NULL;
 *
 * Query for agent's view:
 *   SELECT * FROM rooms WHERE channelId = :channelId AND agentId = :agentId;
 */
```

### Option 2: Lightweight Central Tables

**Add minimal central tables, drop redundant ones:**

```sql
-- Add these:
CREATE TABLE central_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE central_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Drop these (redundant):
DROP TABLE channels;
DROP TABLE message_servers;
DROP TABLE channel_participants; -- Use participants instead
DROP TABLE server_agents; -- Use worlds.agentId instead
```

---

## Migration Path

### Week 1: Create Core (No Breaking Changes)

- [ ] Implement `MessageBusCore` in `packages/core`
- [ ] Add tests for core functionality
- [ ] Document API

### Week 2: Create Adapters (Parallel to Existing)

- [ ] Implement `MessageBusDbAdapter`
- [ ] Implement `MessageBusServerAdapter`
- [ ] Implement `MessageBusAgentAdapter`
- [ ] Test adapters individually

### Week 3: Integration (Feature Flag)

- [ ] Wire up in `AgentServer` behind feature flag
- [ ] Update `SocketIORouter` with conditional logic
- [ ] Run side-by-side with old system
- [ ] Compare outputs for correctness

### Week 4: Browser Mode (New Feature)

- [ ] Implement browser-only mode
- [ ] Create example app
- [ ] Document usage

### Week 5: Migration & Deprecation

- [ ] Make new system default (flip feature flag)
- [ ] Deprecate old code (warnings)
- [ ] Update all documentation

### Week 6: Cleanup

- [ ] Remove deprecated code
- [ ] Remove redundant tables
- [ ] Performance tuning

---

## Success Metrics

1. **Code Reduction**: -30% lines of code in messaging layer
2. **Performance**: Same or better latency for message routing
3. **Capability**: Browser-only mode works without server
4. **Compatibility**: All existing tests pass
5. **Simplicity**: New developers understand message flow in <1 hour

---

## Risks & Mitigation

| Risk                       | Impact   | Mitigation                     |
| -------------------------- | -------- | ------------------------------ |
| Breaking changes           | High     | Feature flag, parallel running |
| Data loss during migration | Critical | Full backup, rollback plan     |
| Performance regression     | Medium   | Load testing, profiling        |
| Agent processing breaks    | High     | Comprehensive test coverage    |
| Socket.io compatibility    | Medium   | Maintain adapter layer         |

---

## Decision Required

**Please approve:**

1. ✅ General approach (MessageBusCore + adapters)
2. ✅ Database schema strategy (Option 1 or Option 2)
3. ✅ Timeline (6 weeks or adjust)
4. ✅ Start with Phase 1 now

**Then I will:**

1. Create `packages/core/src/messaging/bus-core.ts`
2. Write comprehensive tests
3. Create example usage documentation
4. Proceed with adapters

---

**Ready to start implementation? Please confirm and I'll begin with Step 1.**
