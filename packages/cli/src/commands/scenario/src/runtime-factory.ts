import { Character, RuntimeSettings, UUID, IAgentRuntime, stringToUuid } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';
import { setDefaultSecretsFromEnv } from '../../start';
import { AgentServer } from '@elizaos/server';
import { ElizaClient } from '@elizaos/api-client';
import { ChannelType, stringToUuid as stringToUuidCore } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { processManager } from './process-manager';

// --- Start of Pre-emptive Environment Loading ---
loadEnvironmentVariables();

// Get the loaded environment settings
const envSettings = process.env as RuntimeSettings;
// --- End of Pre-emptive Environment Loading ---

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
 * Create (or reuse) an AgentServer and start a minimal test agent for scenarios.
 * Returns the server, runtime, agentId and port. The caller is responsible for cleanup.
 */
export async function createScenarioServerAndAgent(
  existingServer: AgentServer | null = null,
  desiredPort: number = 3000,
  pluginNames: string[] = [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-bootstrap',
    '@elizaos/plugin-e2b',
  ]
): Promise<{
  server: AgentServer;
  runtime: IAgentRuntime;
  agentId: UUID;
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
        const serverPid = (server as any)?.server?.pid || process.pid;
        const runId = `agent-server-${port}`;
        processManager.registerProcess(runId, serverPid, 'agent-server', port);
        console.log(`🔧 [DEBUG] [ProcessManager] Registered AgentServer process ${serverPid} for port ${port}`);
      }
      break; // Success, exit retry loop
    } catch (error) {
      retryCount++;
      console.log(`🔧 [DEBUG] Failed to start server on port ${port}, attempt ${retryCount}/${maxRetries}: ${error}`);

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
    const serverPid = (server as any)?.server?.pid || process.pid;
    processManager.unregisterProcess(serverPid);
    console.log(`🔧 [DEBUG] [ProcessManager] Unregistered AgentServer process ${serverPid} for port ${port}`);

  } catch (error) {
    console.log(`🔧 [DEBUG] Error shutting down AgentServer on port ${port}:`, error);

    // Force terminate the process if graceful shutdown failed
    const serverPid = (server as any)?.server?.pid || process.pid;
    if (processManager.isProcessRunning(serverPid)) {
      console.log(`🔧 [DEBUG] Force terminating AgentServer process ${serverPid}...`);
      processManager.terminateProcess(serverPid);
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
  timeoutMs: number = 30000
): Promise<{ response: string; roomId: UUID }> {
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
      metadata: { scenario: true },
    }),
  });
  if (!channelResponse.ok) throw new Error(`Channel creation failed: ${channelResponse.status}`);
  const channelResult = await channelResponse.json();
  const channel = channelResult.data;
  await client.messaging.addAgentToChannel(channel.id, agentId as UUID);
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
  if (!postResp.ok) {
    const errText = await postResp.text();
    throw new Error(`Post message failed: ${postResp.status} - ${errText}`);
  }
  await postResp.json();
  const startTime = Date.now();

  // Preemptively wait for action response
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  const messages = await client.messaging.getChannelMessages(channel.id, { limit: 20 });
  const agentMessages = messages.messages.filter(
    (msg: any) => msg.authorId === agentId && msg.created_at > startTime
  );
  if (agentMessages.length > 0) {
    const latestMessage = agentMessages.sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];
    return { response: latestMessage.content, roomId: channel.id as UUID };
  }
  throw new Error('Timeout waiting for agent response');
}
