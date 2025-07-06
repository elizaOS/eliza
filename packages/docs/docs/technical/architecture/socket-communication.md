# Socket Communication Architecture

ElizaOS implements real-time communication through WebSocket connections, providing instant message delivery and live interaction capabilities across multiple platforms and agents.

## Overview

The socket communication system enables:

1. **Real-time messaging** - Instant bidirectional communication
2. **Multi-agent coordination** - Live coordination between multiple agents
3. **Cross-platform integration** - Unified communication layer
4. **Event-driven architecture** - Reactive message handling

## Architecture Components

### Server-Side Implementation

#### Socket.IO Server Setup

```typescript
// packages/server/src/socketio/index.ts
import { Server as SocketIOServer } from 'socket.io';

export const setupSocketIO = (server: any, runtime: IAgentRuntime) => {
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Message type definitions
  enum MessageType {
    ROOM_JOINING = 'room_joining',
    SEND_MESSAGE = 'send_message',
    MESSAGE = 'message',
    ACK = 'ack',
    THINKING = 'thinking',
    CONTROL = 'control',
  }

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle message sending
    socket.on(MessageType.SEND_MESSAGE, async (data) => {
      await handleIncomingMessage(socket, data, runtime);
    });

    // Handle room joining
    socket.on(MessageType.ROOM_JOINING, (data) => {
      socket.join(data.roomId);
      console.log(`Socket ${socket.id} joined room ${data.roomId}`);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  return io;
};
```

#### Message Processing Pipeline

```typescript
async function handleIncomingMessage(socket: Socket, data: MessageData, runtime: IAgentRuntime) {
  try {
    // 1. Validate message data
    const validatedData = validateMessageData(data);

    // 2. Create memory object
    const memory: Memory = {
      id: stringToUuid(Date.now().toString()),
      entityId: stringToUuid(validatedData.userId),
      roomId: stringToUuid(validatedData.roomId),
      worldId: stringToUuid(validatedData.worldId || 'default'),
      content: {
        text: validatedData.text,
        source: 'websocket-api',
        metadata: validatedData.metadata || {},
      },
      type: MemoryType.MESSAGE,
    };

    // 3. Store message in database
    await runtime.memory.create(memory);

    // 4. Broadcast message to room participants
    socket.to(validatedData.roomId).emit(MessageType.MESSAGE, {
      id: memory.id,
      userId: memory.entityId,
      text: memory.content.text,
      timestamp: Date.now(),
    });

    // 5. Process with agent runtime
    const response = await runtime.processMessage(memory);

    // 6. Send agent response back to room
    if (response) {
      socket.to(validatedData.roomId).emit(MessageType.MESSAGE, {
        id: response.id,
        userId: runtime.agentId,
        text: response.content.text,
        timestamp: Date.now(),
      });
    }

    // 7. Send acknowledgment
    socket.emit(MessageType.ACK, { success: true, messageId: memory.id });
  } catch (error) {
    console.error('Message processing error:', error);
    socket.emit(MessageType.ACK, { success: false, error: error.message });
  }
}
```

### Client-Side Implementation

#### Socket Manager

```typescript
// packages/client/src/lib/socketio-manager.ts
import { io, Socket } from 'socket.io-client';
import { Evt } from 'evt';

export class SocketIOManager {
  private static instance: SocketIOManager;
  private socket: Socket | null = null;
  private eventBus = Evt.create<SocketEvent>();
  private activeChannels = new Set<string>();

  static getInstance(): SocketIOManager {
    if (!SocketIOManager.instance) {
      SocketIOManager.instance = new SocketIOManager();
    }
    return SocketIOManager.instance;
  }

  connect(url: string): void {
    if (this.socket?.connected) {
      return;
    }

    this.socket = io(url, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Connection events
    this.socket.on('connect', () => {
      console.log('Connected to server');
      this.eventBus.post('connected');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.eventBus.post('disconnected');
    });

    // Message events
    this.socket.on('message', (data: MessageEvent) => {
      this.eventBus.post('message', data);
    });

    this.socket.on('thinking', (data: ThinkingEvent) => {
      this.eventBus.post('thinking', data);
    });

    this.socket.on('ack', (data: AckEvent) => {
      this.eventBus.post('ack', data);
    });
  }

  joinChannel(channelId: string): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }

    this.socket.emit('room_joining', { roomId: channelId });
    this.activeChannels.add(channelId);
  }

  sendMessage(channelId: string, message: string, metadata?: any): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }

    this.socket.emit('send_message', {
      roomId: channelId,
      text: message,
      userId: this.getUserId(),
      metadata,
    });
  }

  // Event subscription interface
  on<T extends keyof SocketEventMap>(
    event: T,
    handler: (data: SocketEventMap[T]) => void
  ): () => void {
    const ctx = this.eventBus.attach(event, handler);
    return () => ctx.detach();
  }
}
```

#### React Integration

```typescript
// packages/client/src/hooks/useSocket.ts
import { useEffect, useState } from 'react';
import { SocketIOManager } from '../lib/socketio-manager';

export function useSocket(serverUrl?: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [socket] = useState(() => SocketIOManager.getInstance());

  useEffect(() => {
    if (serverUrl) {
      socket.connect(serverUrl);
    }

    // Subscribe to connection events
    const unsubscribeConnected = socket.on('connected', () => {
      setIsConnected(true);
    });

    const unsubscribeDisconnected = socket.on('disconnected', () => {
      setIsConnected(false);
    });

    return () => {
      unsubscribeConnected();
      unsubscribeDisconnected();
    };
  }, [serverUrl, socket]);

  return {
    socket,
    isConnected,
    joinChannel: (channelId: string) => socket.joinChannel(channelId),
    sendMessage: (channelId: string, message: string, metadata?: any) =>
      socket.sendMessage(channelId, message, metadata),
  };
}
```

## Message Flow Architecture

### Message Types

```typescript
interface SocketMessage {
  type: MessageType;
  payload: any;
  timestamp: number;
  id: string;
}

enum MessageType {
  // User actions
  ROOM_JOINING = 'room_joining', // User joins a channel
  SEND_MESSAGE = 'send_message', // User sends a message

  // Server responses
  MESSAGE = 'message', // Broadcast message to room
  ACK = 'ack', // Acknowledgment of received message
  THINKING = 'thinking', // Agent is processing (typing indicator)
  CONTROL = 'control', // System control messages
}
```

### Channel Management

```typescript
// Auto-creation of channels for message flow
class ChannelManager {
  private channels = new Map<string, ChannelInfo>();

  async ensureChannel(channelId: string): Promise<ChannelInfo> {
    if (!this.channels.has(channelId)) {
      // Create new channel
      const channel: ChannelInfo = {
        id: channelId,
        participants: new Set(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };

      // Store in database
      await this.saveChannel(channel);
      this.channels.set(channelId, channel);
    }

    return this.channels.get(channelId)!;
  }

  addParticipant(channelId: string, userId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.participants.add(userId);
      channel.lastActivity = Date.now();
    }
  }

  removeParticipant(channelId: string, userId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.participants.delete(userId);

      // Cleanup empty channels
      if (channel.participants.size === 0) {
        this.scheduleChannelCleanup(channelId);
      }
    }
  }
}
```

### Event Broadcasting

```typescript
class EventBroadcaster {
  constructor(private io: SocketIOServer) {}

  // Broadcast to specific room
  broadcastToRoom(roomId: string, event: string, data: any): void {
    this.io.to(roomId).emit(event, {
      ...data,
      timestamp: Date.now(),
      roomId,
    });
  }

  // Broadcast to all connected clients
  broadcastGlobally(event: string, data: any): void {
    this.io.emit(event, {
      ...data,
      timestamp: Date.now(),
    });
  }

  // Send to specific socket
  sendToSocket(socketId: string, event: string, data: any): void {
    this.io.to(socketId).emit(event, {
      ...data,
      timestamp: Date.now(),
    });
  }
}
```

## Integration with Agent Runtime

### Bootstrap Plugin Integration

```typescript
// packages/plugin-bootstrap/src/index.ts
export default {
  name: 'bootstrap',
  description: 'Core event handlers and message routing',

  services: [
    {
      name: 'websocket',
      initialize: async (runtime: IAgentRuntime) => {
        // Handle entity joined events for world/entity creation
        runtime.on('ENTITY_JOINED', async (data) => {
          await handleEntityJoined(runtime, data);
        });

        // Handle messages from socket connections
        runtime.on('MESSAGE_RECEIVED', async (data) => {
          await handleSocketMessage(runtime, data);
        });
      },
    },
  ],
};

async function handleEntityJoined(runtime: IAgentRuntime, data: EntityJoinedEvent) {
  // Ensure world exists
  await runtime.ensureWorldExists({
    id: data.worldId,
    name: data.worldName || 'Socket World',
  });

  // Ensure entity exists
  await runtime.ensureEntityExists({
    id: data.entityId,
    name: data.entityName || 'Socket User',
  });

  // Create or update room
  await runtime.ensureRoomExists({
    id: data.roomId,
    worldId: data.worldId,
    name: data.roomName || 'Socket Channel',
  });
}
```

### Send Handler Registration

```typescript
// Register WebSocket send handler
runtime.sendHandlers.set(
  'websocket-api',
  async (runtime: IAgentRuntime, target: TargetInfo, content: Content) => {
    const socketManager = SocketIOManager.getInstance();

    // Send message through WebSocket
    socketManager.sendMessage(target.roomId, content.text, content.metadata);

    // Also broadcast to room participants
    const io = getSocketIOInstance();
    io.to(target.roomId).emit('message', {
      id: stringToUuid(Date.now().toString()),
      userId: runtime.agentId,
      text: content.text,
      timestamp: Date.now(),
      source: 'agent',
    });
  }
);
```

## Connection Management

### Connection State Tracking

```typescript
class ConnectionManager {
  private connections = new Map<string, ConnectionInfo>();

  trackConnection(socketId: string, info: ConnectionInfo): void {
    this.connections.set(socketId, {
      ...info,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    });
  }

  updateLastSeen(socketId: string): void {
    const connection = this.connections.get(socketId);
    if (connection) {
      connection.lastSeen = Date.now();
    }
  }

  removeConnection(socketId: string): void {
    this.connections.delete(socketId);
  }

  // Get active connections for a room
  getActiveConnections(roomId: string): ConnectionInfo[] {
    return Array.from(this.connections.values()).filter((conn) => conn.roomIds.includes(roomId));
  }

  // Cleanup stale connections
  cleanupStaleConnections(maxAge: number = 5 * 60 * 1000): void {
    const cutoff = Date.now() - maxAge;

    for (const [socketId, connection] of this.connections) {
      if (connection.lastSeen < cutoff) {
        this.removeConnection(socketId);
      }
    }
  }
}
```

### Reconnection Handling

```typescript
// Client-side reconnection logic
class ReconnectionManager {
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  async handleReconnection(socket: Socket): Promise<void> {
    socket.on('disconnect', () => {
      this.startReconnectionProcess();
    });

    socket.on('connect', () => {
      this.resetReconnectionState();
      this.restoreActiveChannels();
    });
  }

  private startReconnectionProcess(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    setTimeout(
      () => {
        this.reconnectAttempts++;
        this.attemptReconnection();
      },
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    );
  }

  private resetReconnectionState(): void {
    this.reconnectAttempts = 0;
  }

  private restoreActiveChannels(): void {
    const socketManager = SocketIOManager.getInstance();

    // Rejoin all previously active channels
    for (const channelId of socketManager.getActiveChannels()) {
      socketManager.joinChannel(channelId);
    }
  }
}
```

## Performance Optimizations

### Message Batching

```typescript
class MessageBatcher {
  private batch: SocketMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly batchSize = 10;
  private readonly batchDelay = 100; // ms

  addMessage(message: SocketMessage): void {
    this.batch.push(message);

    if (this.batch.length >= this.batchSize) {
      this.flushBatch();
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.flushBatch();
      }, this.batchDelay);
    }
  }

  private flushBatch(): void {
    if (this.batch.length > 0) {
      this.processBatch([...this.batch]);
      this.batch = [];
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private processBatch(messages: SocketMessage[]): void {
    // Process batch of messages efficiently
    const grouped = this.groupMessagesByRoom(messages);

    for (const [roomId, roomMessages] of grouped) {
      this.broadcastBatchToRoom(roomId, roomMessages);
    }
  }
}
```

### Connection Pooling

```typescript
class SocketPool {
  private pools = new Map<string, Socket[]>();
  private readonly maxPoolSize = 10;

  getConnection(roomId: string): Socket | null {
    const pool = this.pools.get(roomId) || [];
    return pool.find((socket) => socket.connected) || null;
  }

  addConnection(roomId: string, socket: Socket): void {
    if (!this.pools.has(roomId)) {
      this.pools.set(roomId, []);
    }

    const pool = this.pools.get(roomId)!;

    if (pool.length < this.maxPoolSize) {
      pool.push(socket);
    }

    // Cleanup disconnected sockets
    this.cleanupPool(roomId);
  }

  private cleanupPool(roomId: string): void {
    const pool = this.pools.get(roomId);
    if (pool) {
      const active = pool.filter((socket) => socket.connected);
      this.pools.set(roomId, active);
    }
  }
}
```

## Error Handling and Resilience

### Error Recovery

```typescript
class SocketErrorHandler {
  handleConnectionError(error: Error, socket: Socket): void {
    console.error('Socket connection error:', error);

    // Attempt graceful recovery
    if (this.isRecoverableError(error)) {
      this.scheduleReconnection(socket);
    } else {
      this.handleFatalError(error, socket);
    }
  }

  handleMessageError(error: Error, message: SocketMessage): void {
    console.error('Message processing error:', error);

    // Try to send error response
    try {
      this.sendErrorResponse(message, error);
    } catch (responseError) {
      console.error('Failed to send error response:', responseError);
    }
  }

  private isRecoverableError(error: Error): boolean {
    const recoverableErrors = ['ECONNRESET', 'ENOTFOUND', 'TIMEOUT', 'NETWORK_ERROR'];

    return recoverableErrors.some(
      (errType) => error.message.includes(errType) || error.name.includes(errType)
    );
  }
}
```

### Circuit Breaker Pattern

```typescript
class SocketCircuitBreaker {
  private failureCount = 0;
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 60000; // 1 minute
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private nextAttempt = 0;

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failureCount++;

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeout;
    }
  }
}
```

## Security Considerations

### Authentication and Authorization

```typescript
// JWT-based socket authentication
const authenticateSocket = (socket: Socket, next: (err?: Error) => void) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    socket.userId = decoded.userId;
    socket.permissions = decoded.permissions || [];
    next();
  } catch (error) {
    next(new Error('Invalid token'));
  }
};

// Room access control
const authorizeRoomAccess = async (socket: Socket, roomId: string): Promise<boolean> => {
  // Check if user has permission to access room
  const hasAccess = await checkRoomPermissions(socket.userId, roomId);

  if (!hasAccess) {
    socket.emit('error', { message: 'Access denied to room' });
    return false;
  }

  return true;
};
```

### Rate Limiting

```typescript
class SocketRateLimiter {
  private userLimits = new Map<string, RateLimit>();
  private readonly maxRequests = 100;
  private readonly windowMs = 60000; // 1 minute

  checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const userLimit = this.userLimits.get(userId) || {
      requests: 0,
      resetTime: now + this.windowMs,
    };

    if (now > userLimit.resetTime) {
      userLimit.requests = 0;
      userLimit.resetTime = now + this.windowMs;
    }

    if (userLimit.requests >= this.maxRequests) {
      return false;
    }

    userLimit.requests++;
    this.userLimits.set(userId, userLimit);
    return true;
  }
}
```

This socket communication architecture provides the foundation for real-time interaction in ElizaOS, enabling instant messaging, live agent responses, and coordinated multi-agent communication across various platforms and clients.
