import { Character, UUID, IAgentRuntime, stringToUuid } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import type { Message } from '@elizaos/api-client';
import { ChannelType, stringToUuid as stringToUuidCore } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { processManager } from './process-manager';

/**
 * Find an available port in the given range
 */
async function findAvailablePort(
  startPort: number,
  endPort: number,
  host?: string
): Promise<number> {
  const serverHost = host || process.env.SERVER_HOST || '0.0.0.0';

  // Try ports in random order to avoid conflicts
  const ports = Array.from({ length: endPort - startPort + 1 }, (_, i) => startPort + i);
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j], ports[i]];
  }

  for (const port of ports) {
    try {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.close();
          reject(new Error('Port check timeout'));
        }, 500);

        server.listen(port, serverHost, () => {
          clearTimeout(timeout);
          server.close();
          resolve();
        });
        server.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      return port;
    } catch {
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
    port = await findAvailablePort(3001, 4000);
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
        await server.start({ port, dataDir: uniqueDataDir });
        createdServer = true;

        // Set SERVER_PORT environment variable so MessageBusService uses the correct URL
        // This is critical for scenario testing when the server starts on a different port
        process.env.SERVER_PORT = port.toString();

        // Register the server process for cleanup
        const runId = `agent-server-${port}`;
        processManager.registerProcess(runId, process.pid, 'agent-server', port);
      }
      break; // Success, exit retry loop
    } catch (error) {
      retryCount++;
      if (retryCount >= maxRetries) {
        throw error;
      }

      // Try a different port
      port = await findAvailablePort(port + 1, 3100);
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
  ]
): Promise<{
  runtime: IAgentRuntime;
  agentId: UUID;
}> {
  const character: Character = {
    name: agentName,
    id: stringToUuid(agentName),
    bio: 'A test agent for scenario execution',
    plugins: pluginNames,
    settings: {
      // Let ConfigManager populate minimal, file-scoped secrets.
      secrets: {},
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

  // Pass raw character; encryption and secrets are handled inside startAgents
  const [runtime] = await server.startAgents([{ character }]);
  if (!runtime) {
    throw new Error(`Failed to start agent: ${character.name}`);
  }
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
    // Stop the server
    if (server && typeof server.stop === 'function') {
      await server.stop();
    }

    // Unregister from process manager
    const runId = `agent-server-${port}`;
    processManager.unregisterProcess(runId);
  } catch {
    // Force terminate the process if graceful shutdown failed
    if (processManager.isProcessRunning(process.pid)) {
      const runId = `agent-server-${port}`;
      processManager.terminateProcess(runId);
    }
  }
}

/**
 * Ask an already running agent to respond to input.
 * @param server - The AgentServer instance
 * @param agentId - UUID of the agent
 * @param input - User input message
 * @param timeoutMs - Timeout in milliseconds (default: 60000)
 * @param serverPort - Server port (optional)
 * @param existingChannelId - Optional channel ID to reuse for multi-turn conversations
 * @returns Promise with agent response and channel/room ID
 */
export async function askAgentViaApi(
  _server: AgentServer,
  agentId: UUID,
  input: string,
  timeoutMs: number = 60000,
  serverPort?: number | null,
  existingChannelId?: UUID
): Promise<{ response: string; roomId: UUID }> {
  try {
    // Use provided port or get from environment, fallback to 3000
    const port =
      serverPort ??
      (process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT, 10) : undefined) ??
      3000;
    const client = ElizaClient.create({ baseUrl: `http://localhost:${port}` });

    const { messageServers } = await client.messaging.listMessageServers();
    if (messageServers.length === 0) throw new Error('No servers found');
    const defaultMessageServer = messageServers[0];

    const testUserId = stringToUuidCore('11111111-1111-1111-1111-111111111111');

    let channel;
    if (existingChannelId) {
      try {
        channel = { id: existingChannelId };

        const channelDetailsResponse = await fetch(
          `http://localhost:${port}/api/messaging/central-channels/${existingChannelId}/details`,
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          }
        );

        if (!channelDetailsResponse.ok) {
          throw new Error(`Channel validation failed: ${channelDetailsResponse.status}`);
        }

        const channelDetails = await channelDetailsResponse.json();
        channel = channelDetails.data;
      } catch {
        channel = null;
      }
    }

    if (!channel) {
      const channelResponse = await fetch(
        `http://localhost:${port}/api/messaging/central-channels`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'scenario-test-channel',
            message_server_id: defaultMessageServer.id,
            participantCentralUserIds: [testUserId],
            type: ChannelType.GROUP,
            metadata: { scenario: true },
          }),
        }
      );
      if (!channelResponse.ok) {
        throw new Error(`Channel creation failed: ${channelResponse.status}`);
      }

      const channelResult = await channelResponse.json();
      channel = channelResult.data;
    }

    // Add agent to channel (safe to call even if already added)
    try {
      await client.messaging.addAgentToChannel(channel.id, agentId as UUID);
    } catch {
      // Agent might already be in channel when reusing - this is expected
    }

    // Only sync MessageBusService cache when creating new channels
    if (!existingChannelId) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        await client.messaging.addAgentToChannel(channel.id, agentId as UUID);
      } catch {
        // May already be cached
      }
    }

    // Post a message using the server's expected payload (requires author_id and server_id)
    const postResp = await fetch(
      `http://localhost:${port}/api/messaging/central-channels/${channel.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_id: testUserId,
          content: input,
          message_server_id: defaultMessageServer.id,
          metadata: { scenario: true, user_display_name: 'Scenario User' },
          source_type: 'scenario_message',
        }),
      }
    );
    if (!postResp.ok) {
      const errText = await postResp.text();
      throw new Error(`Post message failed: ${postResp.status} - ${errText}`);
    }

    await postResp.json();

    const startTime = Date.now();
    const pollInterval = 1000;

    const checkForResponse = async (): Promise<{ response: string; roomId: UUID } | null> => {
      const messages = await client.messaging.getChannelMessages(channel.id, { limit: 20 });

      const agentMessages = messages.messages.filter(
        (msg: Message) => msg.authorId === agentId && new Date(msg.createdAt).getTime() > startTime
      );

      if (agentMessages.length > 0) {
        const latestMessage = agentMessages.sort(
          (a: Message, b: Message) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];
        return { response: latestMessage.content, roomId: channel.id as UUID };
      }

      return null;
    };

    return await new Promise<{ response: string; roomId: UUID }>((resolve, reject) => {
      const poll = async () => {
        try {
          if (Date.now() - startTime >= timeoutMs) {
            reject(new Error('Timeout waiting for agent response'));
            return;
          }

          const result = await checkForResponse();
          if (result) {
            resolve(result);
            return;
          }

          setTimeout(poll, pollInterval);
        } catch (error) {
          reject(error);
        }
      };

      poll();
    });
  } catch (error) {
    throw new Error(
      `Failed to get agent response: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
