/**
 * Typed Cloud client for agent-scoped connector binding CRUD. The public DTO
 * intentionally contains no credential locator; only create requests carry a
 * selected platform credential ID to the tenant-authorized API boundary.
 */

import { api } from "../lib/api-client";

export interface AgentConnectorBinding {
  id: string;
  agentId: string;
  provider: string;
  status: string;
  selectedProducts: string[];
  allowedCapabilities: string[];
  isDefault: boolean;
  externalIdentity?: {
    id?: string;
    displayHandle?: string;
  };
}

export interface CreateAgentConnectorBindingInput {
  platformCredentialId: string;
  provider: string;
  role: "OWNER" | "AGENT" | "TEAM";
  purposes?: string[];
  selectedProducts: string[];
  isDefault?: boolean;
}

function connectorBindingsPath(agentId: string, bindingId?: string): string {
  const base = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/connectors`;
  return bindingId ? `${base}/${encodeURIComponent(bindingId)}` : base;
}

export function listAgentConnectorBindings(
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentConnectorBinding[]> {
  return api(connectorBindingsPath(agentId), { signal });
}

export function createAgentConnectorBinding(
  agentId: string,
  input: CreateAgentConnectorBindingInput,
): Promise<AgentConnectorBinding> {
  return api(connectorBindingsPath(agentId), {
    method: "POST",
    json: input,
  });
}

export function revokeAgentConnectorBinding(
  agentId: string,
  bindingId: string,
): Promise<void> {
  return api(connectorBindingsPath(agentId, bindingId), { method: "DELETE" });
}
