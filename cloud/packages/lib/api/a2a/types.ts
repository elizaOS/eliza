/**
 * A2A (Agent-to-Agent) Types
 *
 * Re-exports core A2A types and defines service-specific types
 */

import type { Organization } from "@/db/schemas/organizations";
import type { UserWithOrganization } from "@/lib/types";

// Re-export core A2A types
export type {
  Artifact,
  JSONRPCRequest,
  JSONRPCResponse,
  Message,
  MessageSendParams,
  Part,
  Task,
  TaskCancelParams,
  TaskGetParams,
  TaskState,
} from "@/lib/types/a2a";

// Re-export value exports
export {
  A2AErrorCodes,
  createArtifact,
  createDataPart,
  createMessage,
  createTask,
  createTaskStatus,
  createTextPart,
  jsonRpcError,
  jsonRpcSuccess,
} from "@/lib/types/a2a";

/**
 * A2A execution context with authenticated user
 */
export interface A2AContext {
  user: UserWithOrganization & {
    organization_id: string;
    organization: Organization;
  };
  apiKeyId: string | null;
  agentIdentifier: string;
}

/**
 * Chat completion result
 */
export interface ChatCompletionResult {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
}

/**
 * Hosted web search result
 */
export interface WebSearchResult {
  answer: string;
  model: string;
  provider: "google";
  query: string;
  responseTime: number;
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
  }>;
  searchQueries: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
}

export interface ExtractPageResult {
  provider: "firecrawl";
  url: string;
  markdown: string | null;
  html: string | null;
  screenshot: string | null;
  links: string[];
  metadata: Record<string, unknown>;
}

export interface BrowserSessionResult {
  session?: {
    id: string;
    title: string;
    url: string;
    partition: string;
    visible: boolean;
    createdAt: string;
    updatedAt: string;
    lastFocusedAt: string | null;
    liveViewUrl?: string | null;
    interactiveLiveViewUrl?: string | null;
    status?: string | null;
    provider?: string | null;
  } | null;
  sessions?: Array<{
    id: string;
    title: string;
    url: string;
    partition: string;
    visible: boolean;
    createdAt: string;
    updatedAt: string;
    lastFocusedAt: string | null;
    liveViewUrl?: string | null;
    interactiveLiveViewUrl?: string | null;
    status?: string | null;
    provider?: string | null;
  }>;
  output?: unknown;
  snapshot?: { data: string };
  closed?: boolean;
}

/**
 * Image generation result
 */
export interface ImageGenerationResult {
  image: string;
  mimeType: string;
  aspectRatio: string;
  cost: number;
}

/**
 * Balance check result
 */
export interface BalanceResult {
  balance: number;
  organizationId: string;
  organizationName: string;
}

/**
 * Usage record
 */
export interface UsageResult {
  usage: Array<{
    id: string;
    type: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    createdAt: string;
  }>;
  total: number;
}

/**
 * Agent list result
 */
export interface ListAgentsResult {
  agents: Array<{
    id: string;
    name: string;
    bio: string | string[] | null;
    avatarUrl: string | null;
    createdAt: Date;
  }>;
  total: number;
}

/**
 * Chat with agent result
 */
export interface ChatWithAgentResult {
  response: string;
  roomId: string;
  messageId: string;
  timestamp: string;
}

/**
 * Memory save result
 */
export interface SaveMemoryResult {
  memoryId: string;
  storage: string;
  cost: number;
}

/**
 * Memory retrieval result
 */
export interface RetrieveMemoriesResult {
  memories: Array<{
    id: string;
    content: string;
    score: number;
    createdAt: string;
  }>;
  count: number;
}

/**
 * Conversation creation result
 */
export interface CreateConversationResult {
  conversationId: string;
  title: string;
  model: string;
  cost: number;
}

/**
 * Container list result
 */
export interface ListContainersResult {
  containers: Array<{
    id: string;
    name: string;
    status: string;
    url: string | null;
    createdAt: Date;
  }>;
  total: number;
}

/**
 * Video generation result
 */
export interface VideoGenerationResult {
  jobId: string;
  status: string;
  cost: number;
}

/**
 * A2A method handler type
 */
export type MethodHandler<T = Record<string, unknown>, R = unknown> = (
  params: T,
  ctx: A2AContext,
) => Promise<R>;

/**
 * Method definition in registry
 */
export interface MethodDefinition {
  handler: MethodHandler;
  description: string;
}
