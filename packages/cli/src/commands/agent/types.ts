/**
 * Interface representing the payload sent when starting an agent.
 */
export interface AgentStartPayload {
  characterPath?: string;
  characterJson?: Record<string, unknown>;
}
