import { beforeAll, describe, expect, it } from 'bun:test';
import { AgentType } from '@babylon/agents';
import { OASFDomainCategories, OASFSkillCategories } from '@babylon/shared';

type DiscoveredAgent = {
  agentId: string;
  name: string;
  description: string;
  type: string;
  capabilities: {
    skills?: string[];
    domains?: string[];
  };
};

type DiscoverResponse = {
  agents: DiscoveredAgent[];
  total: number;
};

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  'http://localhost:3000';

let discoverSnapshot: DiscoverResponse;
let sampleAgent: DiscoveredAgent;

async function discoverAgents(query: string = ''): Promise<DiscoverResponse> {
  const response = await fetch(`${baseUrl}/api/agents/discover${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as DiscoverResponse;
}

function expectAgentMatchesSkill(agent: DiscoveredAgent, skill: string) {
  expect(agent.capabilities.skills ?? []).toContain(skill);
}

function expectAgentMatchesDomain(agent: DiscoveredAgent, domain: string) {
  expect(agent.capabilities.domains ?? []).toContain(domain);
}

describe('A2A Endpoints Integration Tests', () => {
  beforeAll(async () => {
    const health = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(health.ok).toBe(true);

    discoverSnapshot = await discoverAgents('?limit=50');
    expect(Array.isArray(discoverSnapshot.agents)).toBe(true);
    expect(discoverSnapshot.total).toBeGreaterThan(0);

    sampleAgent = discoverSnapshot.agents[0]!;
    expect(sampleAgent.agentId).toBeTruthy();
  });

  describe('GET /api/agents/[agentId]/card', () => {
    it('returns agent card for an existing agent', async () => {
      const response = await fetch(
        `${baseUrl}/api/agents/${sampleAgent.agentId}/card`
      );

      expect(response.status).toBe(200);

      const agentCard = await response.json();

      expect(agentCard).toHaveProperty('version', '1.0');
      expect(agentCard).toHaveProperty('agentId', sampleAgent.agentId);
      expect(agentCard).toHaveProperty('name');
      expect(agentCard).toHaveProperty('description');
      expect(agentCard).toHaveProperty('endpoints');
      expect(agentCard).toHaveProperty('capabilities');
    });

    it('includes OASF skills in the agent card', async () => {
      const response = await fetch(
        `${baseUrl}/api/agents/${sampleAgent.agentId}/card`
      );

      expect(response.status).toBe(200);

      const agentCard = await response.json();

      expect(Array.isArray(agentCard.capabilities.skills)).toBe(true);
    });

    it('includes OASF domains in the agent card', async () => {
      const response = await fetch(
        `${baseUrl}/api/agents/${sampleAgent.agentId}/card`
      );

      expect(response.status).toBe(200);

      const agentCard = await response.json();

      expect(Array.isArray(agentCard.capabilities.domains)).toBe(true);
    });

    it('includes A2A endpoints in the agent card', async () => {
      const response = await fetch(
        `${baseUrl}/api/agents/${sampleAgent.agentId}/card`
      );

      expect(response.status).toBe(200);

      const agentCard = await response.json();

      expect(agentCard.endpoints).toHaveProperty('a2a');
      expect(agentCard.endpoints).toHaveProperty('mcp');
      expect(agentCard.endpoints).toHaveProperty('rpc');
    });

    it('returns 404 for a non-existent agent', async () => {
      const response = await fetch(
        `${baseUrl}/api/agents/non-existent-agent/card`
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Agent not found',
        agentId: 'non-existent-agent',
      });
    });
  });

  describe('GET /api/agents/discover', () => {
    it('discovers active agents', async () => {
      const result = await discoverAgents();

      expect(Array.isArray(result.agents)).toBe(true);
      expect(result.total).toBeGreaterThan(0);
    });

    it('filters agents by OASF skills', async () => {
      const result = await discoverAgents(
        `?skills=${encodeURIComponent(OASFSkillCategories.TRADING)}`
      );

      for (const agent of result.agents) {
        expectAgentMatchesSkill(agent, OASFSkillCategories.TRADING);
      }
    });

    it('filters agents by OASF domains', async () => {
      const result = await discoverAgents(
        `?domains=${encodeURIComponent(OASFDomainCategories.FINANCE)}`
      );

      for (const agent of result.agents) {
        expectAgentMatchesDomain(agent, OASFDomainCategories.FINANCE);
      }
    });

    it('supports "any" match mode for skills', async () => {
      const trading = encodeURIComponent(OASFSkillCategories.TRADING);
      const retrieval = encodeURIComponent(
        OASFSkillCategories.INFORMATION_RETRIEVAL
      );
      const result = await discoverAgents(
        `?skills=${trading},${retrieval}&matchMode=any`
      );

      for (const agent of result.agents) {
        const skills = agent.capabilities.skills ?? [];
        expect(
          skills.includes(OASFSkillCategories.TRADING) ||
            skills.includes(OASFSkillCategories.INFORMATION_RETRIEVAL)
        ).toBe(true);
      }
    });

    it('supports "all" match mode for skills', async () => {
      const analysis = encodeURIComponent(OASFSkillCategories.DATA_ANALYSIS);
      const prediction = encodeURIComponent(OASFSkillCategories.PREDICTION);
      const result = await discoverAgents(
        `?skills=${analysis},${prediction}&matchMode=all`
      );

      for (const agent of result.agents) {
        expectAgentMatchesSkill(agent, OASFSkillCategories.DATA_ANALYSIS);
        expectAgentMatchesSkill(agent, OASFSkillCategories.PREDICTION);
      }
    });

    it('filters by agent type', async () => {
      const result = await discoverAgents('?types=NPC');

      for (const agent of result.agents) {
        expect(agent.type).toBe(AgentType.NPC);
      }
    });

    it('supports pagination', async () => {
      const page1 = await discoverAgents('?limit=1&offset=0');
      const page2 = await discoverAgents('?limit=1&offset=1');

      expect(page1.agents.length).toBeLessThanOrEqual(1);
      expect(page2.agents.length).toBeLessThanOrEqual(1);

      if (page1.agents.length > 0 && page2.agents.length > 0) {
        expect(page1.agents[0]?.agentId).not.toBe(page2.agents[0]?.agentId);
      }
    });

    it('supports search by name or description', async () => {
      const searchToken =
        sampleAgent.name.split(/\s+/).find(Boolean) ?? sampleAgent.name;
      const result = await discoverAgents(
        `?search=${encodeURIComponent(searchToken)}`
      );

      expect(Array.isArray(result.agents)).toBe(true);
      expect(
        result.agents.some((agent) => agent.agentId === sampleAgent.agentId)
      ).toBe(true);
    });

    it('combines multiple filters', async () => {
      const result = await discoverAgents(
        `?types=NPC&skills=${encodeURIComponent(OASFSkillCategories.TRADING)}&domains=${encodeURIComponent(OASFDomainCategories.FINANCE)}`
      );

      for (const agent of result.agents) {
        expect(agent.type).toBe(AgentType.NPC);
        expectAgentMatchesSkill(agent, OASFSkillCategories.TRADING);
        expectAgentMatchesDomain(agent, OASFDomainCategories.FINANCE);
      }
    });
  });

  describe('Agent0 SDK Compatibility', () => {
    it('returns an agent card compatible with Agent0 SDK expectations', async () => {
      const response = await fetch(
        `${baseUrl}/api/agents/${sampleAgent.agentId}/card`
      );

      expect(response.status).toBe(200);

      const agentCard = await response.json();

      expect(agentCard.version).toBe('1.0');
      expect(agentCard).toHaveProperty('agentId');
      expect(agentCard).toHaveProperty('endpoints');
      expect(agentCard.capabilities).toHaveProperty('skills');
      expect(agentCard.capabilities).toHaveProperty('domains');
      expect(Array.isArray(agentCard.capabilities.skills)).toBe(true);
      expect(Array.isArray(agentCard.capabilities.domains)).toBe(true);
      expect(agentCard.endpoints).toHaveProperty('a2a');
      expect(agentCard.endpoints).toHaveProperty('mcp');
    });
  });
});
