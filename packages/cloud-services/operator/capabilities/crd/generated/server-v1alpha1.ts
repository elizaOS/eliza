import { GenericKind, RegisterKind } from "kubernetes-fluent-client";

export interface AgentRef {
  agentId: string;
  characterRef: string;
}

export interface ServerSpec {
  capacity: number;
  tier: "shared" | "dedicated";
  project?: string;
  image: string;
  maxReplicas?: number;
  secretRef?: string;
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
  cooldownPeriod?: number;
  pollingInterval?: number;
  agents?: AgentRef[];
}

export type ServerPhase = "Pending" | "Running" | "ScaledDown" | "Draining";

export interface ServerStatus {
  phase: ServerPhase;
  readyAgents?: number;
  totalAgents?: number;
  replicas?: number;
  podNames?: string[];
  lastActivity?: string;
  observedGeneration?: number;
}

export class Server extends GenericKind {
  declare spec: ServerSpec;
  declare status: ServerStatus;
}

RegisterKind(Server, {
  group: "eliza.ai",
  version: "v1alpha1",
  kind: "Server",
  plural: "servers",
});
