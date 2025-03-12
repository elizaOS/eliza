import { SOCKET_MESSAGE_TYPE } from "../types/index"; // TODO: Import from core instead of local types
import EventEmitter from "events";
import { WorldManager } from "./world-manager";
import { apiClient } from "./api";

const BASE_URL = `ws://localhost:${import.meta.env.VITE_SERVER_PORT}`;

type MessagePayload = Record<string, any>;

class WebSocketsManager extends EventEmitter {
  private static instance: WebSocketsManager | null = null;
  private sockets: Map<string, WebSocket>;
  private readyPromises: Map<string, Promise<void>>;
  private resolveReadyMap: Map<string, () => void>;
  
  private constructor() {
    super();
    this.sockets = new Map();
    this.readyPromises = new Map();
    this.resolveReadyMap = new Map();
    
  }

  public static getInstance(): WebSocketsManager {
    if (!WebSocketsManager.instance) {
      WebSocketsManager.instance = new WebSocketsManager();
    }
    return WebSocketsManager.instance;
  }

  connect(agentId: string, roomId: string): void {
    if (this.sockets.has(agentId)) {
      console.warn(`[WebSocket Client] WebSocket for agent ${agentId} already exists.`);
      return;
    }

    const socket = new WebSocket(BASE_URL);

    const readyPromise = new Promise<void>((resolve) => {
      this.resolveReadyMap.set(agentId, resolve);
    });
    this.readyPromises.set(agentId, readyPromise);

    socket.onopen = () => {
      console.log(`[WebSocket Client] WebSocket connected for agent ${agentId}`);
      this.resolveReadyMap.get(agentId)?.();
      const data = {
        type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
        payload: {
          agentId,
          roomId,
        }
      };
      this.sendMessage(agentId, data);
    };

    socket.onmessage = async (event: MessageEvent) => {
      const messageData = JSON.parse(event.data);
      console.log(`[WebSocket Client] Message for agent ${agentId}:`, messageData, messageData.type);

      const payload = messageData.payload;

      if (messageData.type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
        const response = await apiClient.getAgentCompletion(
          agentId,
          payload.senderId,
          payload.message,
          payload.roomId,
          payload.source,
        );

        if (response?.data?.message?.text) {
          this.handleBroadcastMessage(
            agentId, 
            response?.data?.name,
            response.data.message.text, 
            response.data.roomId,
            response.data.source,
          );
        }
      }
    };

    socket.onerror = (error: Event) => {
      console.error(`[WebSocket Client] WebSocket error for agent ${agentId}:`, error);
    };

    socket.onclose = (event: CloseEvent) => {
      console.log(`[WebSocket Client] WebSocket closed for agent ${agentId}. Reason:`, event.reason);
      this.sockets.delete(agentId);
      this.readyPromises.delete(agentId);
      this.resolveReadyMap.delete(agentId);
    };

    this.sockets.set(agentId, socket);
  }

  async sendMessage(agentId: string, message: MessagePayload): Promise<void> {
    const socket = this.sockets.get(agentId);
    const readyPromise = this.readyPromises.get(agentId);

    if (!socket) {
      console.warn(`[WebSocket Client] Cannot send message, WebSocket for agent ${agentId} does not exist.`);
      return;
    }

    await readyPromise;

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn(`[WebSocket Client] WebSocket for agent ${agentId} is not open.`);
    }
  }

  handleBroadcastMessage(senderId: string, senderName: string, text: string, roomId: string, source: string) {
    console.log(`[WebSocket Client] broadcast: ${senderId} broadcast ${text} to ${roomId}`)
    
    this.emit("messageBroadcast", { senderId, senderName, text, roomId, createdAt: Date.now()});
    this.sendMessage(senderId, {
      type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
      payload: {
        senderId,
        senderName,
        message: text,
        roomId,
        worldId: WorldManager.getWorldId(),
        source,
      }
    })

  }

  disconnect(agentId: string): void {
    const socket = this.sockets.get(agentId);
    if (socket) {
      socket.close();
      this.sockets.delete(agentId);
      this.readyPromises.delete(agentId);
      this.resolveReadyMap.delete(agentId);
      console.log(`[WebSocket Client] WebSocket for agent ${agentId} disconnected.`);
    } else {
      console.warn(`[WebSocket Client] No WebSocket found for agent ${agentId}.`);
    }
  }

  disconnectAll(): void {
    this.sockets.forEach((socket, agentId) => {
      console.log(`[WebSocket Client] Closing WebSocket for agent ${agentId}`);
      
      if (socket.readyState === WebSocket.OPEN) {
        socket.onclose = () => {
          console.log(`[WebSocket Client] WebSocket for agent ${agentId} disconnected.`);
          this.sockets.delete(agentId);
          this.readyPromises.delete(agentId);
          this.resolveReadyMap.delete(agentId);
        };
        socket.close();
      } else {
        console.warn(`[WebSocket Client] WebSocket for agent ${agentId} is already closed or closing.`);
      }
    });
  }
  
  
}

export default WebSocketsManager;
