/**
 * Types for the DAG trace instrumentation layer.
 * Captures all inputs/outputs at every node during a game tick.
 */

export interface TickTrace {
  tickId: string;
  tickNumber: number;
  timestamp: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  dag: DagDefinition;
  nodes: NodeTrace[];
  llmCalls: LLMCallTrace[];
  npcTrajectories: NPCTickTrajectory[];
  tokenStats: TokenStatsSummary;
  gameTickResult: Record<string, unknown>;
  environmentFlags?: Record<string, string | boolean>;
}

export interface DagDefinition {
  nodes: DagNodeDefinition[];
  edges: EdgeDefinition[];
}

export interface DagNodeDefinition {
  id: string;
  name: string;
  phase: string;
  phaseNumber: number;
  description: string;
}

export interface EdgeDefinition {
  source: string;
  target: string;
  label: string;
}

export interface NodeTrace {
  nodeId: string;
  name: string;
  phase: string;
  phaseNumber: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "success" | "error" | "skipped" | "delegated";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  llmCallIds: string[];
  subOperations?: SubOperation[];
}

export interface SubOperation {
  name: string;
  type: "db_write" | "db_read" | "llm" | "computation" | "external";
  startMs: number;
  endMs: number;
  details: Record<string, unknown>;
}

export interface LLMCallTrace {
  callId: string;
  nodeId: string;
  timestamp: number;
  provider: string;
  model: string;
  promptType: string;
  format: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedResponse: unknown;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface NPCTickTrajectory {
  npcId: string;
  npcName: string;
  decisions: NPCDecision[];
  trades: NPCTrade[];
  posts: NPCPost[];
  groupMessages: NPCGroupMessage[];
}

export interface NPCDecision {
  timestamp?: number;
  marketId?: string;
  ticker?: string;
  action: string;
  amount: number;
  confidence: number;
  reasoning: string;
}

export interface NPCTrade {
  timestamp?: number;
  marketId?: string;
  ticker?: string;
  action: string;
  amount: number;
  success: boolean;
  error?: string;
}

export interface NPCPost {
  timestamp?: number;
  postId: string;
  content: string;
  type: string;
}

export interface NPCGroupMessage {
  timestamp?: number;
  groupId: string;
  groupName: string;
  content: string;
}

export interface TokenStatsSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  byPromptType: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number }
  >;
}

export interface LLMCallInput {
  nodeId?: string;
  provider: string;
  model: string;
  promptType: string;
  format: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedResponse: unknown;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  error?: string;
}
