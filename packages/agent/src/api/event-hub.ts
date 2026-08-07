/**
 * Buffers versioned server events and targets serialized payloads to connected
 * WebSocket clients. HTTP composition supplies connection ownership maps while
 * route and runtime code consume this small event boundary.
 */
import type { StreamEventEnvelope } from "./server-types.ts";

export interface EventSocket {
  readonly readyState: number;
  send(message: string): void;
}

export interface EventHubState {
  eventBuffer: StreamEventEnvelope[];
  nextEventId: number;
}

export interface ApiEventHub {
  broadcast(payload: unknown): void;
  publish(
    event: Omit<StreamEventEnvelope, "eventId" | "version" | "bufferSeq">,
  ): void;
  sendToClient(clientId: string, payload: unknown): number;
  sendToConversation(conversationId: string, payload: unknown): number;
}

export function createApiEventHub<Socket extends EventSocket>(options: {
  state: EventHubState;
  clients: Set<Socket>;
  clientIds: WeakMap<Socket, string>;
  activeConversations: WeakMap<Socket, string>;
  reportSendError(error: unknown): void;
  maxBufferedEvents?: number;
}): ApiEventHub {
  const sendWhere = (
    payload: unknown,
    include: (socket: Socket) => boolean,
  ): number => {
    const message = JSON.stringify(payload);
    let delivered = 0;
    for (const client of options.clients) {
      if (client.readyState !== 1 || !include(client)) continue;
      try {
        client.send(message);
        delivered += 1;
      } catch (error) {
        options.reportSendError(error);
      }
    }
    return delivered;
  };

  return {
    broadcast(payload) {
      sendWhere(payload, () => true);
    },
    publish(event) {
      const sequence = options.state.nextEventId;
      const envelope: StreamEventEnvelope = {
        ...event,
        eventId: `evt-${sequence}`,
        bufferSeq: sequence,
        version: 1,
      };
      options.state.nextEventId += 1;
      options.state.eventBuffer.push(envelope);
      const maxBufferedEvents = options.maxBufferedEvents ?? 1_500;
      if (options.state.eventBuffer.length > maxBufferedEvents) {
        options.state.eventBuffer.splice(
          0,
          options.state.eventBuffer.length - maxBufferedEvents,
        );
      }
      sendWhere(envelope, () => true);
    },
    sendToClient(clientId, payload) {
      return sendWhere(
        payload,
        (client) => options.clientIds.get(client) === clientId,
      );
    },
    sendToConversation(conversationId, payload) {
      return sendWhere(
        payload,
        (client) => options.activeConversations.get(client) === conversationId,
      );
    },
  };
}
