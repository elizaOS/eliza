import type { MessageMetadata } from "@feed/shared";

/** Minimal broadcast function signature matching broadcastChatMessage from @feed/api. */
export type BroadcastFn = (
  chatId: string,
  message: {
    id: string;
    content: string;
    chatId: string;
    senderId: string;
    type?: string;
    createdAt: string;
    metadata?: MessageMetadata | null;
  },
) => Promise<void>;

export interface CoordinatorDispatchParams {
  agentId: string;
  ownerId: string;
  /** The command/instruction to send to the agent. */
  message: string;
  teamChatId: string;
  ownerName?: string;
  ownerUsername?: string;
  /** Injected from route layer to avoid importing @feed/api in packages/agents. */
  broadcastFn: BroadcastFn;
}

export interface CoordinatorDispatchResult {
  success: boolean;
  response: string;
  agentId: string;
  agentUsername?: string;
  actionsExecuted: number;
  isLLMFailure: boolean;
  /** Set on ownership / not-found failures. */
  error?: string;
}

export type DispatchAgentChatFn = (
  params: CoordinatorDispatchParams,
) => Promise<CoordinatorDispatchResult>;
