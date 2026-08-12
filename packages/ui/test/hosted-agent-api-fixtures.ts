/**
 * Schema-validated hosted-agent list fixtures for UI route tests. Presentation
 * and summary values come from the server authority so test payloads cannot
 * silently drift from the canonical wire contract.
 */

import {
  deriveAgentHostingCost,
  summarizeAgentHosting,
} from "@elizaos/cloud-shared/lib/services/agent-hosting-presentation";
import type {
  AgentListItemDto,
  AgentsResponse,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  agentListItemSchema,
  agentsResponseSchema,
} from "@elizaos/cloud-shared/types/agent-api-schema";

const FIXTURE_TIMESTAMP = "2026-08-05T00:00:00.000Z";

export function hostedAgent(
  overrides: Partial<AgentListItemDto> & Pick<AgentListItemDto, "id">,
): AgentListItemDto {
  const {
    id,
    agentName = id,
    status = "running",
    databaseStatus = "ready",
    lastBackupAt = null,
    lastHeartbeatAt = null,
    errorMessage = null,
    createdAt = FIXTURE_TIMESTAMP,
    updatedAt = FIXTURE_TIMESTAMP,
    token_address = null,
    token_chain = null,
    token_name = null,
    token_ticker = null,
    dockerImage = null,
    executionTier = "dedicated-always",
    hostingCost: providedHostingCost,
    webUiUrl = null,
  } = overrides;
  const hostingCost =
    providedHostingCost === undefined
      ? deriveAgentHostingCost({
          executionTier,
          status,
          billingStatus: "active",
          lastBackupAt,
        })
      : providedHostingCost;

  return agentListItemSchema.parse({
    id,
    agentName,
    status,
    databaseStatus,
    lastBackupAt,
    lastHeartbeatAt,
    errorMessage,
    createdAt,
    updatedAt,
    token_address,
    token_chain,
    token_name,
    token_ticker,
    dockerImage,
    executionTier,
    hostingCost,
    webUiUrl,
  });
}

export function hostedAgentsResponse(
  agents: readonly AgentListItemDto[],
): AgentsResponse {
  const data = [...agents];
  return agentsResponseSchema.parse({
    success: true,
    data,
    hostingSummary: summarizeAgentHosting(
      data.map((agent) => agent.hostingCost),
      5,
    ),
  });
}
