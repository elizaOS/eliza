import {
  ChannelType,
  type Content,
  createMessageMemory,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { ChatRoom } from "../types.js";
import type { SessionIdentity } from "./identity.js";

export interface SendMessageParams {
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
}

/**
 * Stateless runtime adapter: converts a UI "room + text" into a core message and
 * returns the agent response. All conversation state is owned by the runtime DB
 * (and optionally mirrored in the UI store).
 */
export class AgentClient {
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
    const callback = async (content: Content): Promise<Memory[]> => {
      if (content && typeof content === "object" && "text" in content) {
        const maybeText = content.text;
        if (typeof maybeText === "string") {
          response += maybeText;
          onDelta?.(maybeText);
        }
      }
      return [];
    };

    if (!runtime.messageService) {
      throw new Error("Runtime message service not available");
    }

    await runtime.messageService.handleMessage(
      runtime,
      messageMemory,
      callback,
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
