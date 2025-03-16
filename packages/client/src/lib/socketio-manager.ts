import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import EventEmitter from 'eventemitter3';
import { io, type Socket } from 'socket.io-client';
import { apiClient } from './api';
import { WorldManager } from './world-manager';

const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT}`;

type MessagePayload = Record<string, any>;

class SocketIOManager extends EventEmitter {
  private static instance: SocketIOManager | null = null;
  private sockets: Map<string, Socket>;
  private readyPromises: Map<string, Promise<void>>;
  private resolveReadyMap: Map<string, () => void>;

  private constructor() {
    super();
    this.sockets = new Map();
    this.readyPromises = new Map();
    this.resolveReadyMap = new Map();
  }

  public static getInstance(): SocketIOManager {
    if (!SocketIOManager.instance) {
      SocketIOManager.instance = new SocketIOManager();
    }
    return SocketIOManager.instance;
  }

  connect(agentId: string, roomId: string): void {
    if (this.sockets.has(agentId)) {
      console.warn(`[SocketIO] Socket for agent ${agentId} already exists.`);
      return;
    }

    const socket = io(BASE_URL, {
      query: {
        agentId,
        roomId,
      },
      autoConnect: true,
      reconnection: true,
    });

    const readyPromise = new Promise<void>((resolve) => {
      this.resolveReadyMap.set(agentId, resolve);
    });
    this.readyPromises.set(agentId, readyPromise);

    socket.on('connect', () => {
      console.log(`[SocketIO] Connected for agent ${agentId}`);
      this.resolveReadyMap.get(agentId)?.();
      const data = {
        type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
        payload: {
          agentId,
          roomId,
        },
      };
      this.sendMessage(agentId, data);
    });

    socket.on('message', async (messageData) => {
      console.log(`[SocketIO] Message for agent ${agentId}:`, messageData, messageData.type);

      const payload = messageData.payload;

      if (messageData.type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
        const response = await apiClient.getAgentCompletion(
          agentId,
          payload.senderId,
          payload.message,
          payload.roomId,
          payload.source
        );

        if (response?.data?.message?.text) {
          this.handleBroadcastMessage(
            agentId,
            response?.data?.name,
            response.data.message.text,
            response.data.roomId,
            response.data.source
          );
        }
      }
    });

    socket.on('connect_error', (error) => {
      console.error(`[SocketIO] Connection error for agent ${agentId}:`, error);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[SocketIO] Disconnected for agent ${agentId}. Reason:`, reason);

      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });

    this.sockets.set(agentId, socket);
  }

  async sendMessage(agentId: string, message: MessagePayload): Promise<void> {
    const socket = this.sockets.get(agentId);
    const readyPromise = this.readyPromises.get(agentId);

    if (!socket) {
      console.warn(`[SocketIO] Cannot send message, Socket for agent ${agentId} does not exist.`);
      return;
    }

    await readyPromise;

    if (socket.connected) {
      socket.emit('message', message);
    } else {
      console.warn(`[SocketIO] Socket for agent ${agentId} is not connected.`);
    }
  }

  private cleanupSocket(agentId: string): void {
    this.sockets.delete(agentId);
    this.readyPromises.delete(agentId);
    this.resolveReadyMap.delete(agentId);
  }

  handleBroadcastMessage(
    senderId: string,
    senderName: string,
    text: string,
    roomId: string,
    source: string
  ) {
    console.log(`[SocketIO] Broadcasting: ${senderId} sent "${text}" to room ${roomId}`);

    this.emit('messageBroadcast', {
      senderId,
      senderName,
      text,
      roomId,
      createdAt: Date.now(),
      source,
    });
    this.sendMessage(senderId, {
      type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
      payload: {
        senderId,
        senderName,
        message: text,
        roomId,
        worldId: WorldManager.getWorldId(),
        source,
      },
    });
  }

  disconnect(agentId: string): void {
    const socket = this.sockets.get(agentId);
    if (socket) {
      socket.disconnect();
      this.cleanupSocket(agentId);
      console.log(`[SocketIO] Socket for agent ${agentId} disconnected.`);
    } else {
      console.warn(`[SocketIO] No Socket found for agent ${agentId}.`);
    }
  }

  disconnectAll(): void {
    this.sockets.forEach((socket, agentId) => {
      console.log(`[SocketIO] Closing Socket for agent ${agentId}`);

      if (socket.connected) {
        socket.disconnect();
        this.cleanupSocket(agentId);
      } else {
        this.cleanupSocket(agentId);
        console.warn(`[SocketIO] Socket for agent ${agentId} is already disconnected.`);
      }
    });
  }
}

export default SocketIOManager;
