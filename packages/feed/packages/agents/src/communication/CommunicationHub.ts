/**
 * Agent Communication Hub
 *
 * Central hub for agent-to-agent communication, routing messages between
 * internal and external agents and integrating with EventBus for real-time events.
 *
 * @packageDocumentation
 */

import type {
  ExternalAgentMessage as AgentMessage,
  AgentResponse,
} from "../external/ExternalAgentAdapter";
import { getExternalAgentAdapter } from "../external/ExternalAgentAdapter";
import { agentRegistry } from "../services/agent-registry.service";
import { AgentType } from "../types/agent-registry";
import type { JsonValue } from "../types/common";
import type { AgentEvent, EventBus } from "./EventBus";
import { getEventBus } from "./EventBus";

export interface Message {
  id: string;
  from: string;
  to: string;
  type: string;
  content: JsonValue;
  timestamp: string; // ISO 8601 string for JSON serialization
  metadata: Record<string, JsonValue>;
  contextId?: string;
  streaming?: boolean;
}

/**
 * Type guard to check if data is a Message
 * @internal
 */
function isMessage(data: unknown): data is Message {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data === null
  ) {
    return false;
  }

  const obj = data as Record<string, JsonValue>;
  return (
    typeof obj.id === "string" &&
    typeof obj.from === "string" &&
    typeof obj.to === "string" &&
    typeof obj.type === "string" &&
    typeof obj.content !== "undefined" &&
    typeof obj.timestamp === "string" &&
    typeof obj.metadata === "object" &&
    obj.metadata !== null &&
    !Array.isArray(obj.metadata)
  );
}

/**
 * Message routing information
 */
export interface MessageRoute {
  messageId: string;
  from: string;
  to: string;
  protocol: "internal" | "a2a" | "mcp" | "agent0" | "custom";
  status: "pending" | "sent" | "delivered" | "failed";
  timestamp: string;
  error?: string;
}

/**
 * Communication Hub for Agent Messaging
 *
 * Handles routing, delivery, and event broadcasting for agent-to-agent communication.
 */
export class CommunicationHub {
  private eventBus: EventBus;
  private messageHistory: Message[] = [];
  private routeHistory: MessageRoute[] = [];
  private maxHistorySize: number;

  constructor(eventBus?: EventBus, maxHistorySize = 1000) {
    this.eventBus = eventBus || getEventBus();
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Send message from one agent to another
   * Automatically routes based on agent types
   *
   * @param from - Sender agent ID
   * @param to - Recipient agent ID
   * @param type - Message type
   * @param content - Message content
   * @param metadata - Optional metadata
   * @param contextId - Optional context ID for conversation continuity
   * @param streaming - Optional streaming flag for long-running responses
   */
  async sendMessage(
    from: string,
    to: string,
    type: string,
    content: JsonValue,
    metadata?: Record<string, JsonValue>,
    contextId?: string,
    streaming?: boolean,
  ): Promise<AgentResponse> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const message: Message = {
      id: messageId,
      from,
      to,
      type,
      content,
      timestamp: new Date().toISOString(),
      metadata: metadata || {},
      contextId,
      streaming,
    };

    // Add to history
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Broadcast message sent event (serialize message to JsonValue)
    await this.eventBus.publish(
      "message.sent",
      JSON.parse(JSON.stringify(message)),
      from,
    );

    // Determine routing strategy
    const route = await this.routeMessage(message);

    // Execute delivery
    const response = await this.deliverMessage(message, route);

    // Update route status
    route.status = response.success ? "delivered" : "failed";
    route.error = response.error;

    // Broadcast delivery event (serialize to JsonValue)
    await this.eventBus.publish(
      response.success ? "message.delivered" : "message.failed",
      JSON.parse(JSON.stringify({ message, response })),
      from,
    );

    return response;
    // Add route to history
    this.routeHistory.push(route);
    if (this.routeHistory.length > this.maxHistorySize) {
      this.routeHistory.shift();
    }
  }

  /**
   * Broadcast message to multiple agents
   *
   * @param from - Sender agent ID
   * @param recipients - Array of recipient agent IDs
   * @param type - Message type
   * @param content - Message content
   * @param metadata - Optional metadata
   * @param contextId - Optional context ID for conversation continuity
   */
  async broadcastMessage(
    from: string,
    recipients: string[],
    type: string,
    content: JsonValue,
    metadata?: Record<string, JsonValue>,
    contextId?: string,
  ): Promise<AgentResponse[]> {
    const promises = recipients.map((to) =>
      this.sendMessage(from, to, type, content, metadata, contextId),
    );

    return Promise.all(promises);
  }

  /**
   * Determine message routing strategy
   */
  private async routeMessage(message: Message): Promise<MessageRoute> {
    const route: MessageRoute = {
      messageId: message.id,
      from: message.from,
      to: message.to,
      protocol: "internal",
      status: "pending",
      timestamp: new Date().toISOString(),
    };

    // Check if recipient is external agent
    const recipient = await agentRegistry.getAgentById(message.to);

    if (recipient && recipient.type === AgentType.EXTERNAL) {
      // Get external agent connection to determine protocol
      const externalAdapter = getExternalAgentAdapter();
      const connection = externalAdapter.getConnectionStatus(message.to);

      if (connection) {
        route.protocol = connection.protocol;
      } else {
        route.protocol = "custom";
      }
    } else {
      route.protocol = "internal";
    }

    return route;
  }

  /**
   * Deliver message based on routing strategy
   */
  private async deliverMessage(
    message: Message,
    route: MessageRoute,
  ): Promise<AgentResponse> {
    if (route.protocol === "internal") {
      // Internal delivery via event bus (serialize message to JsonValue)
      await this.eventBus.publish(
        `agent.${message.to}.message`,
        JSON.parse(JSON.stringify(message)),
        message.from,
      );

      return {
        success: true,
        data: { delivered: true, protocol: "internal" },
      };
    }

    // External delivery via ExternalAgentAdapter
    const externalAdapter = getExternalAgentAdapter();
    const agentMessage: AgentMessage = {
      type: message.type,
      content: message.content,
      metadata: {
        ...message.metadata,
        from: message.from,
        messageId: message.id,
        timestamp: message.timestamp,
      },
      contextId: message.contextId,
      streaming: message.streaming,
    };

    return await externalAdapter.sendMessage(message.to, agentMessage);
  }

  /**
   * Subscribe to messages for specific agent
   *
   * @param agentId - Agent ID to receive messages for
   * @param handler - Message handler function
   */
  subscribeToMessages(
    agentId: string,
    handler: (message: Message) => void | Promise<void>,
  ): string {
    // Wrap handler to convert JsonValue back to Message type
    // Message extends JsonValue, so this is safe
    return this.eventBus.subscribe(
      `agent.${agentId}.message`,
      (data: JsonValue) => {
        // Type guard to ensure data is a Message
        if (isMessage(data)) {
          handler(data);
        }
      },
    );
  }

  /**
   * Subscribe to all messages
   *
   * @param handler - Message handler function
   */
  subscribeToAllMessages(
    handler: (message: Message) => void | Promise<void>,
  ): string {
    // Wrap handler to convert JsonValue back to Message type
    // Message extends JsonValue, so this is safe
    return this.eventBus.subscribe("message.*", (data: JsonValue) => {
      // Type guard to ensure data is a Message
      if (
        data &&
        typeof data === "object" &&
        "id" in data &&
        "from" in data &&
        "to" in data
      ) {
        if (isMessage(data)) {
          handler(data);
        }
      }
    });
  }

  /**
   * Unsubscribe from messages
   *
   * @param subscriptionId - Subscription ID from subscribe methods
   */
  unsubscribe(subscriptionId: string): void {
    this.eventBus.unsubscribe(subscriptionId);
  }

  /**
   * Publish custom event
   *
   * @param eventType - Event type
   * @param data - Event data
   * @param agentId - Optional agent ID
   */
  async publishEvent(
    eventType: string,
    data: JsonValue,
    agentId?: string,
  ): Promise<void> {
    await this.eventBus.publish(eventType, data, agentId);
  }

  /**
   * Subscribe to custom events
   *
   * @param eventType - Event type (supports wildcards)
   * @param handler - Event handler
   */
  subscribeToEvent<T extends JsonValue = JsonValue>(
    eventType: string,
    handler: (data: T) => void | Promise<void>,
  ): string {
    return this.eventBus.subscribe(eventType, handler);
  }

  /**
   * Get message history
   *
   * @param agentId - Optional filter by sender or recipient
   * @param limit - Maximum number of messages
   */
  getMessageHistory(agentId?: string, limit = 100): Message[] {
    let messages = this.messageHistory;

    if (agentId) {
      messages = messages.filter((m) => m.from === agentId || m.to === agentId);
    }

    return messages.slice(-limit);
  }

  /**
   * Get route history
   *
   * @param agentId - Optional filter by sender or recipient
   * @param limit - Maximum number of routes
   */
  getRouteHistory(agentId?: string, limit = 100): MessageRoute[] {
    let routes = this.routeHistory;

    if (agentId) {
      routes = routes.filter((r) => r.from === agentId || r.to === agentId);
    }

    return routes.slice(-limit);
  }

  /**
   * Get statistics
   */
  getStats() {
    const routesByProtocol = this.routeHistory.reduce(
      (acc, route) => {
        acc[route.protocol] = (acc[route.protocol] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const routesByStatus = this.routeHistory.reduce(
      (acc, route) => {
        acc[route.status] = (acc[route.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      totalMessages: this.messageHistory.length,
      totalRoutes: this.routeHistory.length,
      routesByProtocol,
      routesByStatus,
      subscriptionCount: this.eventBus.getSubscriptionCount(),
    };
  }

  /**
   * Clear all history
   */
  clearHistory(): void {
    this.messageHistory = [];
    this.routeHistory = [];
    this.eventBus.clearHistory();
  }

  /**
   * Get event history from EventBus
   *
   * @param eventType - Optional filter by event type
   * @param limit - Maximum number of events to return
   */
  getEventHistory(eventType?: string, limit?: number): AgentEvent[] {
    return this.eventBus.getHistory(eventType, limit);
  }
}

// Singleton instance
let communicationHubInstance: CommunicationHub | null = null;

/**
 * Get singleton CommunicationHub instance
 */
export function getCommunicationHub(): CommunicationHub {
  if (!communicationHubInstance) {
    communicationHubInstance = new CommunicationHub();
  }
  return communicationHubInstance;
}
