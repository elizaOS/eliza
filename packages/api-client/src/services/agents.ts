import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import {
  Agent,
  AgentCreateParams,
  AgentLog,
  AgentLogsParams,
  AgentPanel,
  AgentUpdateParams,
  AgentWorld,
  AgentWorldSettings,
} from '../types/agents';

export class AgentsService extends BaseApiClient {
  /**
   * List all agents with minimal details
   */
  async listAgents(): Promise<{ agents: Agent[] }> {
    return this.get<{ agents: Agent[] }>('/api/agents');
  }

  /**
   * Get specific agent details
   */
  async getAgent(agentId: UUID): Promise<Agent> {
    return this.get<Agent>(`/api/agents/${agentId}`);
  }

  /**
   * Create a new agent
   */
  async createAgent(params: AgentCreateParams): Promise<Agent> {
    return this.post<Agent>('/api/agents', params);
  }

  /**
   * Update an existing agent
   */
  async updateAgent(agentId: UUID, params: AgentUpdateParams): Promise<Agent> {
    return this.patch<Agent>(`/api/agents/${agentId}`, params);
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/agents/${agentId}`);
  }

  /**
   * Start an existing agent
   */
  async startAgent(agentId: UUID): Promise<{ status: string }> {
    return this.post<{ status: string }>(`/api/agents/${agentId}/start`);
  }

  /**
   * Stop a running agent
   */
  async stopAgent(agentId: UUID): Promise<{ status: string }> {
    return this.post<{ status: string }>(`/api/agents/${agentId}/stop`);
  }

  /**
   * Get all available worlds
   */
  async getWorlds(): Promise<{ worlds: AgentWorld[] }> {
    return this.get<{ worlds: AgentWorld[] }>('/api/agents/worlds');
  }

  /**
   * Add agent to a world
   */
  async addAgentToWorld(agentId: UUID, worldId: UUID): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(`/api/agents/${agentId}/worlds`, { worldId });
  }

  /**
   * Update agent's world settings
   */
  async updateAgentWorldSettings(
    agentId: UUID,
    worldId: UUID,
    settings: Record<string, any>
  ): Promise<AgentWorldSettings> {
    return this.patch<AgentWorldSettings>(`/api/agents/${agentId}/worlds/${worldId}`, { settings });
  }

  /**
   * Get agent's plugin panels
   */
  async getAgentPanels(agentId: UUID): Promise<{ panels: AgentPanel[] }> {
    const response = await this.get<Array<{ name: string; path: string }>>(
      `/api/agents/${agentId}/panels`
    );

    const panels: AgentPanel[] = (Array.isArray(response) ? response : []).map((panel, index) => ({
      id: `${panel.name}-${index}`, // Generate an ID since server doesn't send one
      name: panel.name,
      url: panel.path,
      type: 'plugin',
    }));

    return { panels };
  }

  /**
   * Get agent logs
   */
  async getAgentLogs(agentId: UUID, params?: AgentLogsParams): Promise<AgentLog[]> {
    return this.get<AgentLog[]>(`/api/agents/${agentId}/logs`, { params });
  }

  /**
   * Delete a specific log entry
   */
  async deleteAgentLog(agentId: UUID, logId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/agents/${agentId}/logs/${logId}`);
  }

  /**
   * Get agents associated with a server
   */
  async getAgentsForServer(
    serverId: UUID
  ): Promise<{ success: boolean; data: { serverId: UUID; agents: UUID[] } }> {
    return this.get<{ success: boolean; data: { serverId: UUID; agents: UUID[] } }>(
      `/api/messaging/servers/${serverId}/agents`
    );
  }

  async addAgentToServer(
    serverId: UUID,
    agentId: UUID
  ): Promise<{ success: boolean; data: { serverId: UUID; agentId: UUID; message: string } }> {
    return this.post<{
      success: boolean;
      data: { serverId: UUID; agentId: UUID; message: string };
    }>(`/api/messaging/servers/${serverId}/agents`, { agentId });
  }

  async removeAgentFromServer(
    serverId: UUID,
    agentId: UUID
  ): Promise<{ success: boolean; data: { serverId: UUID; agentId: UUID; message: string } }> {
    return this.delete<{
      success: boolean;
      data: { serverId: UUID; agentId: UUID; message: string };
    }>(`/api/messaging/servers/${serverId}/agents/${agentId}`);
  }

  async getServersForAgent(
    agentId: UUID
  ): Promise<{ success: boolean; data: { agentId: UUID; servers: UUID[] } }> {
    return this.get<{ success: boolean; data: { agentId: UUID; servers: UUID[] } }>(
      `/api/messaging/agents/${agentId}/servers`
    );
  }
}
