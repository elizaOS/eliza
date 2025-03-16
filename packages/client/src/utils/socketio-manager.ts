import { io, Socket } from 'socket.io-client';

interface ConnectParams {
  agentId: string;
  roomId?: string;
  conceptualRoomId?: string;
  userId: string;
  serverUrl?: string;
}

interface SocketMessage {
  type: string;
  payload: Record<string, any>;
}

export class SocketIOManager {
  private socket: Socket | null = null;
  private serverUrl: string;
  private connected = false;
  private connecting = false;
  private messageListeners: Array<(message: SocketMessage) => void> = [];
  private connectionListeners: Array<(status: boolean) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private currentRoomId: string | null = null;
  private currentConceptualRoomId: string | null = null;
  private agentId: string | null = null;
  private userId: string | null = null;

  constructor(serverUrl = 'http://localhost:3001') {
    this.serverUrl = serverUrl;
  }

  // Connect to a specific room
  async connect({
    agentId,
    roomId,
    conceptualRoomId,
    userId,
    serverUrl,
  }: ConnectParams): Promise<boolean> {
    // Update server URL if provided
    if (serverUrl) {
      this.serverUrl = serverUrl;
    }

    // Don't reconnect if we're already connecting or connected to the same room
    if (this.connecting) {
      console.log('Already connecting to a room, please wait...');
      return false;
    }

    // If already connected to the same room, don't reconnect
    if (
      this.connected &&
      this.agentId === agentId &&
      ((roomId && this.currentRoomId === roomId) ||
        (conceptualRoomId && this.currentConceptualRoomId === conceptualRoomId))
    ) {
      console.log('Already connected to this room');
      return true;
    }

    // Store connection parameters
    this.agentId = agentId;
    this.currentRoomId = roomId || null;
    this.currentConceptualRoomId = conceptualRoomId || null;
    this.userId = userId;

    // Disconnect from any existing connection
    this.disconnect();

    this.connecting = true;
    this.reconnectAttempts = 0;

    try {
      // Connect to socket.io server
      console.log(`Connecting to WebSocket server at ${this.serverUrl}...`);
      this.socket = io(this.serverUrl, {
        path: '/socket.io',
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        transports: ['websocket', 'polling'],
      });

      return new Promise<boolean>((resolve) => {
        if (!this.socket) {
          console.error('Socket initialization failed');
          this.connecting = false;
          this.notifyConnectionListeners(false);
          resolve(false);
          return;
        }

        // Set up connection event handlers
        this.socket.on('connect', () => {
          console.log('Socket.IO connected!');

          // Determine which room ID to join
          const targetRoomId = this.currentConceptualRoomId || this.currentRoomId || this.agentId;

          if (!targetRoomId) {
            console.error('No roomId or conceptualRoomId specified for connection');
            this.disconnect();
            this.connecting = false;
            this.notifyConnectionListeners(false);
            resolve(false);
            return;
          }

          // Join room
          this.socket.emit('message', {
            type: 'ROOM_JOINING',
            payload: {
              roomId: targetRoomId,
              entityId: this.userId,
            },
          });
        });

        // Set up error handlers
        this.socket.on('connect_error', (error: Error) => {
          console.error('Socket.IO connection error:', error);
          this.connecting = false;
          this.connected = false;
          this.notifyConnectionListeners(false);
          resolve(false);
        });

        this.socket.on('connect_timeout', () => {
          console.error('Socket.IO connection timeout');
          this.connecting = false;
          this.connected = false;
          this.notifyConnectionListeners(false);
          resolve(false);
        });

        this.socket.on('error', (error: Error) => {
          console.error('Socket.IO error:', error);
          this.connected = false;
          this.notifyConnectionListeners(false);
        });

        this.socket.on('disconnect', (reason: string) => {
          console.log(`Socket.IO disconnected: ${reason}`);
          this.connected = false;
          this.notifyConnectionListeners(false);

          // Try to reconnect if disconnected unexpectedly
          if (
            reason === 'io server disconnect' ||
            reason === 'transport close' ||
            reason === 'ping timeout'
          ) {
            this.reconnect();
          }
        });

        // Handle room joined confirmation
        this.socket.on('message', (data: SocketMessage) => {
          if (data.type === 'room_joined') {
            console.log('Successfully joined room:', data.payload);
            this.connected = true;
            this.connecting = false;

            // If this was a conceptual room join, store the agent-specific room mappings
            if (data.payload.conceptualRoomId) {
              this.currentConceptualRoomId = data.payload.conceptualRoomId;

              // If we have agent room mappings, store the first one as current room
              if (data.payload.mappings && data.payload.mappings.length > 0) {
                this.currentRoomId = data.payload.mappings[0].agentRoomId;
              } else if (data.payload.agentRoomId) {
                // For agent connections, we get a direct agent room mapping
                this.currentRoomId = data.payload.agentRoomId;
              }
            } else {
              // Direct room connection
              this.currentRoomId = data.payload.roomId;
            }

            this.notifyConnectionListeners(true);
            resolve(true);

            return;
          }

          // Forward other messages to listeners
          for (const listener of this.messageListeners) {
            listener(data);
          }
        });

        // Handle legacy 'data' events for backward compatibility
        this.socket.on(
          'data',
          (data: { senderId: string; roomId: string; message: string; file?: any }) => {
            // Convert to new message format
            const formattedMessage: SocketMessage = {
              type: 'MESSAGE',
              payload: {
                senderId: data.senderId,
                roomId: data.roomId,
                content: {
                  text: data.message,
                  file: data.file,
                },
                timestamp: Date.now(),
              },
            };

            // Notify listeners
            for (const listener of this.messageListeners) {
              listener(formattedMessage);
            }
          }
        );
      });
    } catch (error) {
      console.error('Error connecting to socket:', error);
      this.connecting = false;
      this.notifyConnectionListeners(false);
      return false;
    }
  }

  private reconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Maximum reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `Reconnecting... Attempt ${this.reconnectAttempts} of ${this.maxReconnectAttempts}`
    );

    this.reconnectTimeout = setTimeout(() => {
      if (this.agentId && this.userId) {
        this.connect({
          agentId: this.agentId,
          roomId: this.currentRoomId || undefined,
          conceptualRoomId: this.currentConceptualRoomId || undefined,
          userId: this.userId,
        });
      }
    }, 2000 * this.reconnectAttempts); // Increase delay with each attempt
  }

  // Send a message to the current room
  sendMessage(message: string, metadata: Record<string, any> = {}): boolean {
    if (!this.socket || !this.connected) {
      console.error('Cannot send message: not connected to a room');
      return false;
    }

    if (!this.currentRoomId && !this.currentConceptualRoomId) {
      console.error('Cannot send message: no room ID available');
      return false;
    }

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Determine the target room ID (prefer conceptual room ID if available)
    const targetRoomId = this.currentConceptualRoomId || this.currentRoomId;

    console.log(`Sending message to room ${targetRoomId}`, {
      text: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      metadata,
    });

    try {
      this.socket.emit('message', {
        type: 'SEND_MESSAGE',
        payload: {
          senderId: this.userId,
          roomId: targetRoomId,
          message: message,
          messageId,
          ...metadata,
        },
      });
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }

  // Subscribe to messages
  onMessage(callback: (message: SocketMessage) => void): () => void {
    this.messageListeners.push(callback);
    return () => {
      this.messageListeners = this.messageListeners.filter((listener) => listener !== callback);
    };
  }

  // Subscribe to connection status changes
  onConnectionChange(callback: (status: boolean) => void): () => void {
    this.connectionListeners.push(callback);
    // Immediately notify with current status
    callback(this.connected);
    return () => {
      this.connectionListeners = this.connectionListeners.filter(
        (listener) => listener !== callback
      );
    };
  }

  // Notify all connection listeners
  private notifyConnectionListeners(status: boolean) {
    for (const listener of this.connectionListeners) {
      listener(status);
    }
  }

  // Check if connected
  isConnected(): boolean {
    return this.connected;
  }

  // Get the current room ID
  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }

  // Get the current conceptual room ID
  getCurrentConceptualRoomId(): string | null {
    return this.currentConceptualRoomId;
  }

  // Disconnect from the current room
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    this.notifyConnectionListeners(false);
  }

  // Disconnect from all connections when app is shutting down
  disconnectAll(): void {
    this.disconnect();
  }
}
