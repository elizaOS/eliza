import { Character, RuntimeSettings, UUID, IAgentRuntime, stringToUuid } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';
import { setDefaultSecretsFromEnv } from '../../start';
import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType, stringToUuid as stringToUuidCore } from '@elizaos/core';

// --- Start of Pre-emptive Environment Loading ---
console.log('[ENV] Loading environment configuration...');
loadEnvironmentVariables();

// Get the loaded environment settings
const envSettings = process.env as RuntimeSettings;
console.log(`[ENV] Environment loaded with ${Object.keys(envSettings).length} variables`);
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
    await server.initialize({ dataDir: './test-data' });
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
    }
  } as Character;

  const secrets = await setDefaultSecretsFromEnv(character);
  console.log('secrets', secrets);
  // Pass raw character; encryption is handled inside startAgent
  const runtime = await server.startAgent(character);
  console.log('runtime', runtime);
  const agentId = runtime.character.id as UUID;
  console.log('agentId', agentId);

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
  console.log('defaultServer', defaultServer);
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
  console.log('channelResponse', channelResponse);
  if (!channelResponse.ok) throw new Error(`Channel creation failed: ${channelResponse.status}`);
  const channelResult = await channelResponse.json();
  console.log('channelResult', channelResult);
  const channel = channelResult.data;
  console.log('channel', channel);
  const addAgentToChannel = await client.messaging.addAgentToChannel(channel.id, agentId as UUID);
  console.log('addAgentToChannel', addAgentToChannel);
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
  const postMessage = await postResp.json();
  console.log('postMessage', postMessage);

  const startTime = Date.now();
  const pollInterval = 1000;
  while (Date.now() - startTime < timeoutMs) {
    const messages = await client.messaging.getChannelMessages(channel.id, { limit: 10 });
    console.log('messages', messages);

    messages.messages.forEach((msg: any) => {
      console.log('msg', msg);
    });
    const agentMessage = messages.messages.find((msg: any) =>
      msg.authorId === agentId && msg.created_at > Date.now() - 10000
    );
    console.log('agentMessage', agentMessage);
    if (agentMessage) return agentMessage.content;
    console.log('waiting for agent response');
    await new Promise(resolve => setTimeout(resolve, pollInterval));

  }
  throw new Error('Timeout waiting for agent response');
}



