import { Character, RuntimeSettings, UUID, IAgentRuntime, stringToUuid } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';
import { setDefaultSecretsFromEnv } from '../../start';
import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType, stringToUuid as stringToUuidCore } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';

// --- Start of Pre-emptive Environment Loading ---
loadEnvironmentVariables();

// Get the loaded environment settings
const envSettings = process.env as RuntimeSettings;
// --- End of Pre-emptive Environment Loading ---

/**
 * Create (or reuse) an AgentServer and start a minimal test agent for scenarios.
 * Returns the server, runtime, agentId and port. The caller is responsible for cleanup.
 */
export async function createScenarioServerAndAgent(
  existingServer: AgentServer | null = null,
  desiredPort: number = 3000,
  pluginNames: string[] = ['@elizaos/plugin-sql', '@elizaos/plugin-openai', '@elizaos/plugin-bootstrap', '@elizaos/plugin-e2b']
): Promise<{ server: AgentServer; runtime: IAgentRuntime; agentId: UUID; port: number; createdServer: boolean }> {
  let server: AgentServer;
  let createdServer = false;
  let port = desiredPort;

  if (existingServer) {
    server = existingServer;
  } else {
    server = new AgentServer();
    // Prefer unique directory per scenario run under PGLite root (env or default .eliza/.elizadb)
    const pgliteRoot = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), '.eliza', '.elizadb');
    const uniqueDataDir = path.join(
      pgliteRoot,
      `scenario-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    try {
      fs.mkdirSync(uniqueDataDir, { recursive: true });
    } catch {
      // Best-effort; initialization will surface errors if any
    }
    // Persist the chosen directory for downstream consumers
    process.env.PGLITE_DATA_DIR = uniqueDataDir;
    await server.initialize({ dataDir: uniqueDataDir });
    const { startAgent: serverStartAgent, stopAgent: serverStopAgent } = await import('../../start/actions/agent-start');
    server.startAgent = (character) => serverStartAgent(character, server!);
    server.stopAgent = (runtime) => serverStopAgent(runtime, server!);
    await server.start(port);
    createdServer = true;
  }
  const character: Character = {
    name: 'scenario-agent',
    id: stringToUuid('scenario-agent'),
    bio: 'A test agent for scenario execution',
    plugins: pluginNames,
    settings: {
      secrets: {
        ...(envSettings as Record<string, any>),
      },
    },
    // Always respond: set system prompt and template to ensure reply
    system: 'Always respond to every message, even if the input is unclear or empty. Never ignore a user message.',
    // Add minimal required fields for Character type
    topics: ['testing', 'scenarios', 'automation'],
    adjectives: ['responsive', 'reliable', 'test-oriented'],
    style: {
      all: ['Always reply', 'Be concise and clear'],
      chat: ['Direct', 'Helpful'],
    },
  };

  await setDefaultSecretsFromEnv(character);
  // Pass raw character; encryption is handled inside startAgent
  const runtime = await server.startAgent(character);
  const agentId = runtime.character.id as UUID;

  return { server, runtime, agentId, port, createdServer };
}

/**
 * Ask an already running agent (connected to the provided server) to respond to input.
 * Does not create or stop the server/agent.
 */
export async function askAgentViaApi(
  server: AgentServer,
  agentId: UUID,
  input: string,
  timeoutMs: number = 30000
): Promise<string> {
  const port = (server as any)?.port ?? 3000;
  const client = ElizaClient.create({ baseUrl: `http://localhost:${port}` });
  const { servers } = await client.messaging.listServers();
  if (servers.length === 0) throw new Error('No servers found');
  const defaultServer = servers[0];
  const testUserId = stringToUuidCore('11111111-1111-1111-1111-111111111111');
  const channelResponse = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'scenario-test-channel',
      server_id: defaultServer.id,
      participantCentralUserIds: [testUserId],
      type: ChannelType.GROUP,
      metadata: { scenario: true }
    })
  });
  if (!channelResponse.ok) throw new Error(`Channel creation failed: ${channelResponse.status}`);
  const channelResult = await channelResponse.json();
  const channel = channelResult.data;
  await client.messaging.addAgentToChannel(channel.id, agentId as UUID);
  // Post a message using the server's expected payload (requires author_id and server_id)
  const postResp = await fetch(`http://localhost:${port}/api/messaging/central-channels/${channel.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author_id: testUserId,
      content: input,
      server_id: defaultServer.id,
      metadata: { scenario: true, user_display_name: 'Scenario User' },
      source_type: 'scenario_message'
    })
  });
  if (!postResp.ok) {
    const errText = await postResp.text();
    throw new Error(`Post message failed: ${postResp.status} - ${errText}`);
  }
  await postResp.json();
  const startTime = Date.now();

  // Preemptively wait for action response
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
  const messages = await client.messaging.getChannelMessages(channel.id, { limit: 20 });
  const agentMessages = messages.messages.filter((msg: any) =>
    msg.authorId === agentId && msg.created_at > startTime
  );
  if (agentMessages.length > 0) {
    const latestMessage = agentMessages.sort((a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];
    return latestMessage.content;
  }
  throw new Error('Timeout waiting for agent response');
}



