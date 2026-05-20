export interface TraceSummary {
  dirName: string;
  tickId: string;
  tickNumber?: number;
  timestamp?: string;
  durationMs?: number;
  nodeCount?: number;
  llmCallCount?: number;
}

export interface TraceNodeData {
  nodeId: string;
  name: string;
  phase: string;
  phaseNumber: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "success" | "error" | "skipped";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  llmCallIds: string[];
}

export interface LLMCallSummary {
  callId: string;
  nodeId: string;
  promptType: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
}

export interface LLMCallFull {
  callId: string;
  nodeId: string;
  promptType: string;
  provider: string;
  model: string;
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
}

export interface NPCTrajectory {
  npcId: string;
  npcName: string;
  decisions: Array<{
    action: string;
    ticker?: string;
    amount: number;
    confidence: number;
    reasoning: string;
  }>;
  trades: Array<{
    action: string;
    ticker?: string;
    amount: number;
    success: boolean;
  }>;
  posts: Array<{ postId: string; content: string; type: string }>;
  groupMessages: Array<{ groupId: string; groupName: string; content: string }>;
}

export interface TraceData {
  tickId: string;
  tickNumber: number;
  timestamp: string;
  durationMs: number;
  dag: {
    nodes: Array<{
      id: string;
      name: string;
      phase: string;
      phaseNumber: number;
      description: string;
    }>;
    edges: Array<{ source: string; target: string; label: string }>;
  };
  nodes: TraceNodeData[];
  llmCallSummaries: LLMCallSummary[];
  llmCallsFull?: LLMCallFull[];
  npcTrajectories?: NPCTrajectory[];
  tokenStats: {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    estimatedCostUSD: number;
  };
  gameTickResult: Record<string, unknown>;
}
