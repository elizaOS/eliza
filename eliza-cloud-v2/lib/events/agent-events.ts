/**
 * Agent event emitter for Eliza agent runtime events.
 *
 * Publishes events to Redis for real-time updates across serverless instances.
 */

import { Redis } from "@upstash/redis";
import { logger } from "@/lib/utils/logger";
import type { Memory, UUID } from "@elizaos/core";

/**
 * Agent event structure.
 */
export interface AgentEvent {
  type:
    | "message_received"
    | "response_started"
    | "response_chunk"
    | "response_complete"
    | "error";
  roomId: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

/**
 * Event emitter for agent runtime events using Redis pub/sub.
 */
class AgentEventEmitter {
  private static instance: AgentEventEmitter;
  private redis: Redis | null = null;
  private enabled: boolean = false;

  private constructor() {
    this.initialize();
  }

  private initialize(): void {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      this.enabled = false;
      return;
    }

    this.redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    this.enabled = true;
  }

  public static getInstance(): AgentEventEmitter {
    if (!AgentEventEmitter.instance) {
      AgentEventEmitter.instance = new AgentEventEmitter();
    }
    return AgentEventEmitter.instance;
  }

  async emitMessageReceived(roomId: string, message: Memory): Promise<void> {
    if (!this.enabled || !this.redis) return;

    const event: AgentEvent = {
      type: "message_received",
      roomId,
      timestamp: new Date(),
      data: {
        messageId: message.id,
        content: message.content,
        entityId: message.entityId,
      },
    };

    await this.publishEvent(roomId, event);
  }

  async emitResponseStarted(roomId: string, agentId: UUID): Promise<void> {
    if (!this.enabled || !this.redis) return;

    const event: AgentEvent = {
      type: "response_started",
      roomId,
      timestamp: new Date(),
      data: {
        agentId,
        status: "processing",
      },
    };

    // Fire-and-forget: don't await Redis operations
    void this.publishEvent(roomId, event);
  }

  async emitResponseChunk(
    roomId: string,
    chunk: string,
    tokenIndex: number,
  ): Promise<void> {
    if (!this.enabled || !this.redis) return;

    const event: AgentEvent = {
      type: "response_chunk",
      roomId,
      timestamp: new Date(),
      data: {
        chunk,
        tokenIndex,
      },
    };

    await this.publishEvent(roomId, event);
  }

  async emitResponseComplete(
    roomId: string,
    response: Memory,
    usage?: { inputTokens: number; outputTokens: number; model: string },
  ): Promise<void> {
    if (!this.enabled || !this.redis) return;

    const event: AgentEvent = {
      type: "response_complete",
      roomId,
      timestamp: new Date(),
      data: {
        messageId: response.id,
        content: response.content,
        usage,
      },
    };

    // Fire-and-forget: don't await Redis operations
    void this.publishEvent(roomId, event);
  }

  async emitError(roomId: string, error: Error): Promise<void> {
    if (!this.enabled || !this.redis) return;

    const event: AgentEvent = {
      type: "error",
      roomId,
      timestamp: new Date(),
      data: {
        error: error.message,
        stack: error.stack,
      },
    };

    await this.publishEvent(roomId, event);
  }

  private async publishEvent(roomId: string, event: AgentEvent): Promise<void> {
    if (!this.redis) return;

    const channel = `agent:events:${roomId}:queue`;
    const message = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });

    await this.redis.rpush(channel, message);
    await this.redis.expire(channel, 300);

    logger.debug(`[Agent Events] Published ${event.type} to ${channel}`);
  }

  public isEnabled(): boolean {
    return this.enabled;
  }
}

export const agentEventEmitter = AgentEventEmitter.getInstance();
