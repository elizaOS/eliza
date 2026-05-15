export type SetupSessionId = string;
export type TenantId = string;
export type ContainerStatus = "provisioning" | "ready" | "failed";

export interface SetupSessionEnvelope {
  sessionId: SetupSessionId;
  tenantId: TenantId;
  createdAt: number;
  containerStatus: ContainerStatus;
  containerId?: string;
}

export interface SetupActionPolicy {
  allowList: readonly string[];
  budgets: {
    maxTokensPerTurn: number;
    maxToolCallsPerTurn: number;
    maxTurns: number;
  };
}

export interface SetupTranscriptMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: number;
}

export interface SetupExtractedFact {
  key: string;
  value: string;
  confidence: number;
  source: "user" | "agent" | "system";
}

export interface ContainerHandoffEnvelope {
  sessionId: SetupSessionId;
  tenantId: TenantId;
  containerId: string;
  transcript: SetupTranscriptMessage[];
  facts: SetupExtractedFact[];
  memoryIds: string[];
}
