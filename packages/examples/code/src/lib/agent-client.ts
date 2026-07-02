import {
  ChannelType,
  type Content,
  createMessageMemory,
  type IAgentRuntime,
  type Memory,
  type StreamChunkCallback,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { ChatRoom } from "../types.js";
import type { SessionIdentity } from "./identity.js";

const STREAM_EVENT_TYPES = new Set([
  "tool_call",
  "tool_result",
  "evaluation",
  "context_event",
]);

interface SendMessageParams {
  room: ChatRoom;
  text: string;
  identity: SessionIdentity;
  userName?: string;
  source?: string;
  channelType?: ChannelType;
  /**
   * Optional streaming callback. Called with each incremental text chunk
   * produced by the runtime.
   */
  onDelta?: (delta: string) => void;
  /** Optional caller-controlled cancellation signal for in-flight turns. */
  abortSignal?: AbortSignal;
}

function hasStreamingEventType(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function isStructuredStreamEvent(chunk: string): boolean {
  const trimmed = chunk.trimStart();
  if (!trimmed.startsWith("{")) return false;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return hasStreamingEventType(parsed) && STREAM_EVENT_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

/**
 * Stateless runtime adapter: converts a UI "room + text" into a core message and
 * returns the agent response. All conversation state is owned by the runtime DB
 * (and optionally mirrored in the UI store).
 */
class AgentClient {
  private runtime: IAgentRuntime | null = null;

  setRuntime(runtime: IAgentRuntime): void {
    this.runtime = runtime;
  }

  async sendMessage(params: SendMessageParams): Promise<string> {
    if (!this.runtime) {
      throw new Error("Runtime not initialized");
    }

    const runtime = this.runtime;
    const { room, text, identity } = params;
    const source = params.source ?? "eliza-code";
    const channelType = params.channelType ?? ChannelType.DM;
    const userName = params.userName ?? "User";
    const onDelta = params.onDelta;

    await runtime.ensureConnection({
      entityId: identity.userId,
      roomId: room.elizaRoomId,
      worldId: identity.worldId,
      userName,
      source,
      type: channelType,
      channelId: room.id,
      messageServerId: identity.messageServerId,
    });

    const messageMemory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: identity.userId,
      roomId: room.elizaRoomId,
      content: {
        text,
        source,
        channelType,
      },
    });

    let response = "";
    let streamedText = "";
    let didStreamText = false;

    const emitStreamDelta = (delta: string): void => {
      if (!delta) return;
      didStreamText = true;
      onDelta?.(delta);
    };

    const handleStreamChunk: StreamChunkCallback = (
      chunk,
      _messageId,
      accumulated,
    ) => {
      if (typeof accumulated === "string") {
        if (accumulated === streamedText) return;

        let delta = "";
        if (accumulated.startsWith(streamedText)) {
          delta = accumulated.slice(streamedText.length);
          streamedText = accumulated;
        } else {
          delta = chunk;
          streamedText += chunk;
        }

        response = accumulated;
        emitStreamDelta(delta);
        return;
      }

      if (isStructuredStreamEvent(chunk)) return;

      streamedText += chunk;
      response = streamedText;
      emitStreamDelta(chunk);
    };

    const callback = async (content: Content): Promise<Memory[]> => {
      if (content && typeof content === "object" && "text" in content) {
        const maybeText = content.text;
        if (typeof maybeText === "string") {
          response = maybeText;
          if (!didStreamText) {
            streamedText = maybeText;
            emitStreamDelta(maybeText);
          } else if (maybeText.startsWith(streamedText)) {
            const finalDelta = maybeText.slice(streamedText.length);
            streamedText = maybeText;
            emitStreamDelta(finalDelta);
          } else {
            streamedText = maybeText;
          }
        }
      }
      return [];
    };

    if (!runtime.messageService) {
      throw new Error("Runtime message service not available");
    }

    const options =
      params.abortSignal || onDelta
        ? {
            ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
            ...(onDelta ? { onStreamChunk: handleStreamChunk } : {}),
          }
        : undefined;

    await runtime.messageService.handleMessage(
      runtime,
      messageMemory,
      callback,
      options,
    );

    return response;
  }

  async clearConversation(room: ChatRoom): Promise<void> {
    if (!this.runtime) return;
    const runtime = this.runtime;
    if (!runtime.messageService) return;
    await runtime.messageService.clearChannel(
      runtime,
      room.elizaRoomId,
      room.id,
    );
  }
}

let agentClientInstance: AgentClient | null = null;

export function getAgentClient(): AgentClient {
  if (!agentClientInstance) {
    agentClientInstance = new AgentClient();
  }
  return agentClientInstance;
}

export function resetAgentClient(): void {
  agentClientInstance = null;
}
