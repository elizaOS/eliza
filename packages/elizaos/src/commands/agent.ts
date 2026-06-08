/**
 * `elizaos agent`
 *
 * Subcommands for managing Eliza Cloud agents:
 *   list    — list all agents for the authenticated user
 *   create  — create a new agent (optionally linked to a character)
 *   provision — trigger provisioning for an existing agent by id
 */

import pc from "picocolors";
import {
  cloudRequest,
  resolveApiBaseUrl,
  resolveApiKey,
} from "../cloud-api.js";
import type { AgentOptions } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────────

interface AgentListItem {
  id: string;
  agentName: string | null;
  status: string;
  dockerImage: string | null;
  executionTier: string | null;
  createdAt: string;
  webUiUrl: string | null;
}

interface AgentListResponse {
  success: boolean;
  data: AgentListItem[];
}

interface CreateAgentResponse {
  success: boolean;
  data?: {
    id?: string;
    agentId?: string;
    agentName?: string | null;
    status?: string;
    jobId?: string;
    executionTier?: string;
  };
}

interface AgentLifecycleResponse {
  success?: boolean;
  jobId?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function printAgentRow(agent: AgentListItem): void {
  const statusColor =
    agent.status === "running"
      ? pc.green
      : agent.status === "provisioning" || agent.status === "pending"
        ? pc.yellow
        : agent.status === "error"
          ? pc.red
          : pc.dim;
  console.log(
    `  ${pc.dim(agent.id.slice(0, 8))}  ${statusColor(agent.status.padEnd(14))}  ${pc.bold(agent.agentName ?? "(unnamed)")}${agent.executionTier ? `  ${pc.dim(agent.executionTier)}` : ""}`,
  );
}

// ── Commands ──────────────────────────────────────────────────────────

/**
 * `elizaos agent list` — list all agents for the authenticated org.
 */
export async function agentList(): Promise<number> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red(
        "Missing Eliza Cloud API key. Set ELIZAOS_CLOUD_API_KEY, ELIZA_CLOUD_API_KEY, ELIZACLOUD_API_KEY, or ~/.elizaos/credentials.json.",
      ),
    );
    return 1;
  }

  const apiBaseUrl = resolveApiBaseUrl();

  try {
    const response = await cloudRequest<AgentListResponse>(
      apiBaseUrl,
      apiKey,
      "GET",
      "/api/v1/eliza/agents",
    );

    const agents = response.data ?? [];
    if (agents.length === 0) {
      console.log(pc.dim("No agents found."));
      return 0;
    }

    console.log(pc.bold(`\n  ${agents.length} agent(s):\n`));
    for (const agent of agents) {
      printAgentRow(agent);
    }
    console.log();
    return 0;
  } catch (error) {
    console.error(
      pc.red(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

/**
 * `elizaos agent create <name>` — create a new cloud agent.
 * Optionally link to a saved character via --character-id.
 */
export async function agentCreate(
  name: string | undefined,
  options: AgentOptions,
): Promise<number> {
  const agentName = (name ?? "").trim();
  if (!agentName) {
    console.error(pc.red("Agent name is required."));
    return 1;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red(
        "Missing Eliza Cloud API key. Set ELIZAOS_CLOUD_API_KEY, ELIZA_CLOUD_API_KEY, ELIZACLOUD_API_KEY, or ~/.elizaos/credentials.json.",
      ),
    );
    return 1;
  }

  const apiBaseUrl = resolveApiBaseUrl();

  const body: Record<string, unknown> = {
    agentName,
    autoProvision: !options.noProvision,
  };

  if (options.characterId) {
    body.characterId = options.characterId;
  }

  if (options.dockerImage) {
    body.dockerImage = options.dockerImage;
  }

  try {
    const response = await cloudRequest<CreateAgentResponse>(
      apiBaseUrl,
      apiKey,
      "POST",
      "/api/v1/eliza/agents",
      body,
    );

    const agentId = response.data?.agentId ?? response.data?.id;
    const status = response.data?.status ?? "created";

    console.log(pc.green(`\n  Agent "${agentName}" created.`));
    console.log(`  ID:     ${pc.bold(agentId ?? "unknown")}`);
    console.log(`  Status: ${status}`);

    if (response.data?.jobId) {
      console.log(`  Job:    ${response.data.jobId}`);
    }

    console.log();
    return 0;
  } catch (error) {
    console.error(
      pc.red(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

/**
 * `elizaos agent provision <id>` — trigger provisioning for an existing agent.
 */
export async function agentProvision(
  agentId: string | undefined,
): Promise<number> {
  if (!agentId?.trim()) {
    console.error(pc.red("Agent ID is required."));
    return 1;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red(
        "Missing Eliza Cloud API key. Set ELIZAOS_CLOUD_API_KEY, ELIZA_CLOUD_API_KEY, ELIZACLOUD_API_KEY, or ~/.elizaos/credentials.json.",
      ),
    );
    return 1;
  }

  const apiBaseUrl = resolveApiBaseUrl();

  try {
    const response = await cloudRequest<AgentLifecycleResponse>(
      apiBaseUrl,
      apiKey,
      "POST",
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    );

    console.log(pc.green(`\n  Provisioning triggered for agent ${agentId}.`));
    if (response.jobId) {
      console.log(`  Job: ${response.jobId}`);
    }
    console.log();
    return 0;
  } catch (error) {
    console.error(
      pc.red(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}
