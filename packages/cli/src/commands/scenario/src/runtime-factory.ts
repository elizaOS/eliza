import { Character, RuntimeSettings, UUID, IAgentRuntime, stringToUuid } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';
import { setDefaultSecretsFromEnv } from '../../start';
import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import type { Message } from '@elizaos/api-client';
import { ChannelType, stringToUuid as stringToUuidCore } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { processManager } from './process-manager';

// Lazy initialization of environment settings
let envSettings: RuntimeSettings | null = null;
let envLoaded = false;

function ensureEnvLoaded(): RuntimeSettings {
  if (!envLoaded) {
    loadEnvironmentVariables();
    envSettings = process.env as RuntimeSettings;
    envLoaded = true;
  }

  if (!envSettings) {
    throw new Error('Failed to load environment settings');
  }

  return envSettings;
}

/**
 * Find an available port in the given range
 */
async function findAvailablePort(startPort: number, endPort: number): Promise<number> {
  console.log(`🔧 [DEBUG] Searching for available port in range ${startPort}-${endPort}...`);

  // Try ports in random order to avoid conflicts
  const ports = Array.from({ length: endPort - startPort + 1 }, (_, i) => startPort + i);
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j], ports[i]];
  }

  for (const port of ports) {
    try {
      console.log(`🔧 [DEBUG] Testing port ${port}...`);
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.close();
          reject(new Error('Port check timeout'));
        }, 500); // Reduced timeout

        server.listen(port, () => {
          clearTimeout(timeout);
          server.close();
          resolve();
        });
        server.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      console.log(`🔧 [DEBUG] Port ${port} is available`);
      return port;
    } catch (error) {
      console.log(`🔧 [DEBUG] Port ${port} is in use: ${error}`);
      // Port is in use, try next one
      continue;
    }
  }
  throw new Error(`No available ports found in range ${startPort}-${endPort}`);
}

/**
 * Creates and initializes a properly configured AgentServer for scenario testing
 * @param existingServer - Optional existing server to reuse
 * @param desiredPort - Port to run on (0 for auto-find)
 * @returns Configured and started AgentServer with port info
 */
export async function createScenarioServer(
  existingServer: AgentServer | null = null,
  desiredPort: number = 3000
): Promise<{
  server: AgentServer;
  port: number;
  createdServer: boolean;
}> {
  let server: AgentServer | undefined;
  let createdServer = false;
  let port = desiredPort;

  // If port is 0, find an available port
  if (port === 0) {
    console.log('🔧 [DEBUG] Finding available port in range 3001-4000...');
    port = await findAvailablePort(3001, 4000);
    console.log(`🔧 [DEBUG] Found available port: ${port}`);
  }

  // Try to start the server with retry logic
  let retryCount = 0;
  const maxRetries = 3;

  while (retryCount < maxRetries) {
    try {
      if (existingServer) {
        server = existingServer;
      } else {
        server = new AgentServer();
        // Prefer unique directory per scenario run under PGLite root (env or default .eliza/.elizadb)
        const pgliteRoot =
          process.env.PGLITE_DATA_DIR || path.join(process.cwd(), '.eliza', '.elizadb');
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
        const { startAgent: serverStartAgent, stopAgent: serverStopAgent } = await import(
          '../../start/actions/agent-start'
        );
        server.startAgent = (character) => serverStartAgent(character, server!);
        server.stopAgent = (runtime) => serverStopAgent(runtime, server!);
        await server.start(port);
        createdServer = true;

        // Register the server process for cleanup
        const serverPid = (server as any).server?.pid || process.pid;
        const runId = `agent-server-${port}`;
        processManager.registerProcess(runId, serverPid, 'agent-server', port);
        console.log(
          `🔧 [DEBUG] [ProcessManager] Registered AgentServer process ${serverPid} for port ${port}`
        );
      }
      break; // Success, exit retry loop
    } catch (error) {
      retryCount++;
      console.log(
        `🔧 [DEBUG] Failed to start server on port ${port}, attempt ${retryCount}/${maxRetries}: ${error}`
      );

      if (retryCount >= maxRetries) {
        throw error;
      }

      // Try a different port
      port = await findAvailablePort(port + 1, 3100);
      console.log(`🔧 [DEBUG] Retrying with new port: ${port}`);
    }
  }

  // Ensure server is defined
  if (!server) {
    throw new Error('Failed to create or initialize server after retries');
  }

  return { server, port, createdServer };
}

/**
 * Creates and starts an agent on an existing AgentServer
 * @param server - The AgentServer to create agent on
 * @param agentName - Unique name for the agent (defaults to 'scenario-agent')
 * @param pluginNames - Plugins to load for the agent
 * @returns Started agent runtime and ID
 */
export async function createScenarioAgent(
  server: AgentServer,
  agentName: string = 'scenario-agent',
  pluginNames: string[] = [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-bootstrap',
    '@elizaos/plugin-e2b',
  ]
): Promise<{
  runtime: IAgentRuntime;
  agentId: UUID;
}> {
  console.log(
    `🔧 [DEBUG] createScenarioAgent called for agent: ${agentName}, plugins: ${pluginNames.join(', ')}`
  );
  const character: Character = {
    name: agentName,
    id: stringToUuid(agentName),
    bio: 'A test agent for scenario execution',
    plugins: pluginNames,
    settings: {
      secrets: {
        ...ensureEnvLoaded(),
      },
    },
    // Always respond: set system prompt and template to ensure reply
    system:
      'Always respond to every message, even if the input is unclear or empty. Never ignore a user message.',
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

  return { runtime, agentId };
}

/**
 * Creates a configured AgentServer and starts an agent (backward compatible wrapper)
 * @deprecated Consider using createScenarioServer() + createScenarioAgent() for better flexibility
 */
export async function createScenarioServerAndAgent(
  existingServer: AgentServer | null = null,
  desiredPort: number = 3000,
  pluginNames: string[] = [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-bootstrap',
    '@elizaos/plugin-e2b',
  ],
  agentName: string = 'scenario-agent'
): Promise<{
  server: AgentServer;
  runtime: IAgentRuntime;
  agentId: UUID;
  port: number;
  createdServer: boolean;
}> {
  // Step 1: Create/configure the server
  const { server, port, createdServer } = await createScenarioServer(existingServer, desiredPort);

  // Step 2: Create the agent on the server
  const { runtime, agentId } = await createScenarioAgent(server, agentName, pluginNames);

  return { server, runtime, agentId, port, createdServer };
}

/**
 * Properly shutdown an AgentServer instance
 */
export async function shutdownScenarioServer(server: AgentServer, port: number): Promise<void> {
  try {
    console.log(`🔧 [DEBUG] Shutting down AgentServer on port ${port}...`);

    // Stop the server
    if (server && typeof server.stop === 'function') {
      await server.stop();
      console.log(`🔧 [DEBUG] AgentServer on port ${port} stopped successfully`);
    }

    // Unregister from process manager
    const runId = `agent-server-${port}`;
    processManager.unregisterProcess(runId);
    console.log(`🔧 [DEBUG] [ProcessManager] Unregistered AgentServer for port ${port}`);
  } catch (error) {
    console.log(`🔧 [DEBUG] Error shutting down AgentServer on port ${port}:`, error);

    // Force terminate the process if graceful shutdown failed
    const serverPid = (server as { server?: { pid?: number } })?.server?.pid || process.pid;
    if (processManager.isProcessRunning(serverPid)) {
      console.log(`🔧 [DEBUG] Force terminating AgentServer process ${serverPid}...`);
      const runId = `agent-server-${port}`;
      processManager.terminateProcess(runId);
    }
  }
}

/**
 * Ask an already running agent (connected to the provided server) to respond to input.
 * Does not create or stop the server/agent.
 */
export async function askAgentViaApi(
  server: AgentServer,
  agentId: UUID,
  input: string,
  timeoutMs: number = 30000,
  serverPort?: number | null
): Promise<{ response: string; roomId: UUID }> {
  console.log(`🔧 [askAgentViaApi] === FUNCTION START ===`);
  console.log(
    `🔧 [askAgentViaApi] Parameters: agentId=${agentId}, input="${input}", serverPort=${serverPort}`
  );

  try {
    // Use provided port or try to extract from server, fallback to 3000
    const port = serverPort ?? (server as AgentServer & { port?: number })?.port ?? 3000;
    console.log(
      `🔧 [askAgentViaApi] Port calculation: provided=${serverPort}, server.port=${(server as AgentServer & { port?: number })?.port}, final=${port}`
    );

    console.log(`🔧 [askAgentViaApi] Creating ElizaClient with baseUrl: http://localhost:${port}`);
    console.log(`🔧 [askAgentViaApi] Environment check for comparison:`);
    console.log(`🔧 [askAgentViaApi]   - SERVER_PORT env: ${process.env.SERVER_PORT || 'NOT SET'}`);
    console.log(
      `🔧 [askAgentViaApi]   - CENTRAL_MESSAGE_SERVER_URL env: ${process.env.CENTRAL_MESSAGE_SERVER_URL || 'NOT SET'}`
    );
    const client = ElizaClient.create({ baseUrl: `http://localhost:${port}` });
    console.log(`🔧 [askAgentViaApi] ✅ ElizaClient created`);

    console.log(`🔧 [askAgentViaApi] About to call client.messaging.listServers()...`);
    const { servers } = await client.messaging.listServers();
    console.log(`🔧 [askAgentViaApi] ✅ listServers() returned ${servers.length} servers`);

    if (servers.length === 0) throw new Error('No servers found');
    const defaultServer = servers[0];
    console.log(
      `🔧 [askAgentViaApi] Using server: ${defaultServer.id} (${defaultServer.name || 'unnamed'})`
    );

    const testUserId = stringToUuidCore('11111111-1111-1111-1111-111111111111');
    console.log(`🔧 [askAgentViaApi] Test user ID: ${testUserId}`);

    console.log(
      `🔧 [askAgentViaApi] About to create channel via POST /api/messaging/central-channels...`
    );
    const channelResponse = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'scenario-test-channel',
        server_id: defaultServer.id,
        participantCentralUserIds: [testUserId],
        type: ChannelType.GROUP,
        metadata: { scenario: true },
      }),
    });
    console.log(`🔧 [askAgentViaApi] Channel creation response status: ${channelResponse.status}`);
    if (!channelResponse.ok) throw new Error(`Channel creation failed: ${channelResponse.status}`);

    console.log(`🔧 [askAgentViaApi] About to parse channel response JSON...`);
    const channelResult = await channelResponse.json();
    console.log(`🔧 [askAgentViaApi] ✅ Channel response parsed`);

    const channel = channelResult.data;
    console.log(
      `🔧 [askAgentViaApi] Channel created: ${channel.id} (${channel.name || 'unnamed'})`
    );

    console.log(`🔧 [askAgentViaApi] About to add agent ${agentId} to channel ${channel.id}...`);
    await client.messaging.addAgentToChannel(channel.id, agentId as UUID);
    console.log(`🔧 [askAgentViaApi] ✅ Agent added to channel`);

    console.log(
      `🔧 [askAgentViaApi] About to post message via POST /api/messaging/central-channels/${channel.id}/messages...`
    );
    // Post a message using the server's expected payload (requires author_id and server_id)
    const postResp = await fetch(
      `http://localhost:${port}/api/messaging/central-channels/${channel.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_id: testUserId,
          content: input,
          server_id: defaultServer.id,
          metadata: { scenario: true, user_display_name: 'Scenario User' },
          source_type: 'scenario_message',
        }),
      }
    );
    console.log(`🔧 [askAgentViaApi] Message post response status: ${postResp.status}`);
    if (!postResp.ok) {
      const errText = await postResp.text();
      console.log(`🔧 [askAgentViaApi] ❌ Post failed: ${postResp.status} - ${errText}`);
      throw new Error(`Post message failed: ${postResp.status} - ${errText}`);
    }

    console.log(`🔧 [askAgentViaApi] About to parse post response JSON...`);
    await postResp.json();
    console.log(`🔧 [askAgentViaApi] ✅ Message posted successfully`);

    const startTime = Date.now();
    console.log(
      `🔧 [askAgentViaApi] Starting time: ${startTime}, waiting up to ${timeoutMs}ms for response...`
    );

    // Poll for response at regular intervals instead of waiting full timeout
    const pollInterval = 100; // Check every 100ms

    const checkForResponse = async (): Promise<{ response: string; roomId: UUID } | null> => {
      console.log(`🔧 [askAgentViaApi] About to call getChannelMessages...`);
      const messages = await client.messaging.getChannelMessages(channel.id, { limit: 20 });
      console.log(
        `🔧 [askAgentViaApi] ✅ Got ${messages.messages?.length || 0} messages from channel`
      );

      const agentMessages = messages.messages.filter(
        (msg: Message) => msg.authorId === agentId && new Date(msg.createdAt).getTime() > startTime
      );
      console.log(
        `🔧 [askAgentViaApi] Found ${agentMessages.length} agent messages after startTime`
      );

      if (agentMessages.length > 0) {
        const latestMessage = agentMessages.sort(
          (a: Message, b: Message) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];
        console.log(`🔧 [askAgentViaApi] ✅ Returning latest message: "${latestMessage.content}"`);
        return { response: latestMessage.content, roomId: channel.id as UUID };
      }

      return null; // No response yet
    };

    // Implement proper polling with timeout
    return await new Promise<{ response: string; roomId: UUID }>((resolve, reject) => {
      const poll = async () => {
        try {
          // Check if we've exceeded timeout
          if (Date.now() - startTime >= timeoutMs) {
            console.log(`🔧 [askAgentViaApi] ❌ Timeout after ${timeoutMs}ms - no agent response`);
            reject(new Error('Timeout waiting for agent response'));
            return;
          }

          // Check for response
          const result = await checkForResponse();
          if (result) {
            resolve(result);
            return;
          }

          // No response yet, schedule next check
          setTimeout(poll, pollInterval);
        } catch (error) {
          console.log(`🔧 [askAgentViaApi] ❌ Error during polling:`, error);
          reject(error);
        }
      };

      // Start polling
      poll();
    });
  } catch (error) {
    console.log(`🔧 [askAgentViaApi] ❌ EXCEPTION CAUGHT:`, error);
    throw error; // Re-throw the error
  }
}
