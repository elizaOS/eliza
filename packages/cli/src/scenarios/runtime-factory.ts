import { Character, stringToUuid, IAgentRuntime, RuntimeSettings, encryptedCharacter, AgentRuntime } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';
import { IDatabaseAdapter, Agent, Entity, Room, UUID } from '@elizaos/core';
import { setDefaultSecretsFromEnv, startAgent } from '../commands/start';
import { configureDatabaseSettings, resolvePgliteDir } from '../utils';
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

import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import { e2bPlugin } from '@elizaos/plugin-e2b';
import { openaiPlugin } from '@elizaos/plugin-openai';

/**
 * Simple mock database adapter for testing scenarios without database dependencies
 */
class MockDatabaseAdapter implements IDatabaseAdapter {
  async init(): Promise<void> {
    // No-op for testing
  }

  async initialize(): Promise<void> {
    // No-op for testing
  }



  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No-op for testing
  }

  async getAgent(agentId: UUID): Promise<Agent | null> {
    return {
      id: agentId,
      name: 'test-agent',
      bio: 'Test agent for scenarios',
      plugins: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async getAgents(): Promise<Agent[]> {
    return [];
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    return true;
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return true;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    return true;
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    return {
      id: agent.id || 'test-agent-id' as UUID,
      name: agent.name || 'test-agent',
      bio: agent.bio || 'Test agent',
      plugins: agent.plugins || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async getEntityById(entityId: UUID): Promise<Entity | null> {
    // Return a mock entity for the agent
    return {
      id: entityId,
      names: ['test-entity'],
      metadata: {},
      agentId: entityId
    };
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    // Return mock entities for the requested IDs
    return entityIds.map(id => ({
      id,
      names: ['test-entity'],
      metadata: {},
      agentId: id
    }));
  }

  async createEntity(entity: Entity): Promise<boolean> {
    return true;
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    return true;
  }

  async updateEntity(entity: Entity): Promise<void> {
    // No-op
  }

  async getRoom(roomId: UUID): Promise<Room | null> {
    return null;
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    return [];
  }

  async createRoom(params: any): Promise<UUID> {
    return params.id || 'test-room-id' as UUID;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return rooms.map(r => r.id);
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    // No-op
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    // No-op
  }

  async updateRoom(room: Room): Promise<void> {
    // No-op
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return [];
  }

  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return true;
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return true;
  }

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return true;
  }

  async getParticipantsForEntity(entityId: UUID): Promise<any[]> {
    return [];
  }

  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return [];
  }

  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return [];
  }

  async getRooms(worldId: UUID): Promise<Room[]> {
    return [];
  }

  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return [];
  }

  async getParticipantUserState(roomId: UUID, entityId: UUID): Promise<'FOLLOWED' | 'MUTED' | null> {
    return null;
  }

  async setParticipantUserState(roomId: UUID, entityId: UUID, state: 'FOLLOWED' | 'MUTED' | null): Promise<void> {
    // No-op
  }

  async createRelationship(params: any): Promise<boolean> {
    return true;
  }

  async updateRelationship(relationship: any): Promise<void> {
    // No-op
  }

  async getRelationship(params: any): Promise<any> {
    return null;
  }

  async getRelationships(params: any): Promise<any[]> {
    return [];
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    return undefined;
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    return true;
  }

  async deleteCache(key: string): Promise<boolean> {
    return true;
  }

  async createTask(task: any): Promise<UUID> {
    return 'test-task-id' as UUID;
  }

  async getTasks(params: any): Promise<any[]> {
    return [];
  }

  async getTask(id: UUID): Promise<any | null> {
    return null;
  }

  async getTasksByName(name: string): Promise<any[]> {
    return [];
  }

  async updateTask(id: UUID, task: any): Promise<void> {
    // No-op
  }

  async deleteTask(id: UUID): Promise<void> {
    // No-op
  }

  async getMemoryById(id: UUID): Promise<any | null> {
    return null;
  }

  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<any[]> {
    return [];
  }

  async log(params: any): Promise<void> {
    // No-op
  }

  async createMemory(memory: any, tableName: string, unique?: boolean): Promise<UUID> {
    return 'test-memory-id' as UUID;
  }

  async updateMemory(memory: any): Promise<boolean> {
    return true;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    // No-op
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    // No-op
  }

  async clearAllAgentMemories(): Promise<void> {
    // No-op
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    // No-op
  }

  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number> {
    return 0;
  }

  async getLogs(params: any): Promise<any[]> {
    return [];
  }

  async deleteLog(logId: UUID): Promise<void> {
    // No-op
  }

  async createWorld(world: any): Promise<UUID> {
    return 'test-world-id' as UUID;
  }

  async getWorld(id: UUID): Promise<any | null> {
    return null;
  }

  async removeWorld(worldId: UUID): Promise<void> {
    // No-op
  }

  async getAllWorlds(): Promise<any[]> {
    return [];
  }

  async updateWorld(world: any): Promise<void> {
    // No-op
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<any[]> {
    return [];
  }

  async getComponent(entityId: UUID, type: string, worldId?: UUID, sourceEntityId?: UUID): Promise<any | null> {
    return null;
  }

  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<any[]> {
    return [];
  }

  async createComponent(component: any): Promise<boolean> {
    return true;
  }

  async updateComponent(component: any): Promise<void> {
    // No-op
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    // No-op
  }

  async addEmbeddingToMemory(memory: any): Promise<any> {
    return memory;
  }

  async getMemories(params: any): Promise<any[]> {
    return [];
  }

  async getAllMemories(): Promise<any[]> {
    return [];
  }

  async searchMemories(params: any): Promise<any[]> {
    return [];
  }

  async rerankMemories(query: string, memories: any[]): Promise<any[]> {
    return memories;
  }

  async getCachedEmbeddings(params: any): Promise<any[]> {
    return [];
  }

  async getMemoriesByWorldId(params: any): Promise<any[]> {
    return [];
  }

  async getMemoriesByRoomIds(params: any): Promise<any[]> {
    return [];
  }

  async getMemoriesByEntities(params: any): Promise<any[]> {
    return [];
  }

  async searchMemoriesByEmbedding(embedding: number[], params?: any): Promise<any[]> {
    return [];
  }

  async deleteEntity(entityId: UUID): Promise<void> {
    // No-op
  }

  async getEntityDetails(params: any): Promise<any[]> {
    return [];
  }

  async getEntities(params: any): Promise<any[]> {
    return [];
  }

  async getParticipantsForAccount(entityId: any): Promise<any[]> {
    return [];
  }

  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    // No-op
  }

  async runMigrations(migrationsPaths?: string[]): Promise<void> {
    // No-op
  }

  async getConnection(): Promise<any> {
    return null;
  }

  get db(): any {
    return {};
  }
}

/**
 * Creates a minimal runtime with E2B, SQL, and OpenAI plugins loaded for scenario execution
 */
export async function initializeAgent(): Promise<IAgentRuntime> {
  // Create minimal character for E2B operations
  const character: Character = {
    name: 'scenario-runner',
    id: stringToUuid('scenario-runner'),
    bio: 'A minimal character for running scenarios',
    plugins: [
      '@elizaos/plugin-sql',
      '@elizaos/plugin-e2b',
      '@elizaos/plugin-openai',
      '@elizaos/plugin-bootstrap'
    ]
  };
  console.log('[DEBUG] initializeAgent: Character created');

  // Ensure secrets are set from env if not present
  await setDefaultSecretsFromEnv(character);
  console.log('[DEBUG] initializeAgent: Secrets set from env');

  console.log('[DEBUG] initializeAgent: Creating AgentRuntime...');
  const postgresUrl = await configureDatabaseSettings(false);
  if (postgresUrl) process.env.POSTGRES_URL = postgresUrl;

  const pgliteDataDir = postgresUrl ? undefined : await resolvePgliteDir();

  // Use a real AgentServer instance
  const server = new AgentServer();
  await server.initialize({
    dataDir: pgliteDataDir,
    postgresUrl: postgresUrl || undefined,
  });
  // Use startAgent for full, real initialization
  const runtime = await startAgent(
    encryptedCharacter(character),
    server,
    undefined,
    [], // 
    { isTestMode: false }
  );

  console.log('[DEBUG] initializeAgent: Runtime initialized successfully');

  return runtime;
}

export async function createE2BRuntime(): Promise<AgentRuntime> {
  // Create minimal character for E2B operations
  const character: Character = {
    name: 'scenario-runner',
    id: stringToUuid('scenario-runner'),
    bio: 'A minimal character for running scenarios',
    plugins: [
      '@elizaos/plugin-sql',
      '@elizaos/plugin-e2b',
      '@elizaos/plugin-openai',
    ]
  };
  const mockAdapter = new MockDatabaseAdapter();
  const runtime = new AgentRuntime({ character, plugins: [sqlPlugin, e2bPlugin, openaiPlugin], settings: envSettings, adapter: mockAdapter });
  await runtime.initialize();
  return runtime;
}

/**
 * Handle natural language agent interaction via API client
 */
export async function handleNaturalLanguageInteraction(
  server: AgentServer | null,
  agentId: string,
  input: string,
  timeoutMs: number = 30000
): Promise<string> {
  let localServer: AgentServer | null = null;
  let port = 3000;

  try {
    // Create server if not provided
    if (!server) {
      localServer = new AgentServer();
      await localServer.initialize({
        dataDir: './test-data',
      });

      // Set up the server methods like the CLI does
      const { startAgent, stopAgent } = await import('../commands/start/actions/agent-start');
      localServer.startAgent = (character) => startAgent(character, localServer!);
      localServer.stopAgent = (runtime) => stopAgent(runtime, localServer!);

      await localServer.start(port);
      console.log(`✅ Server started on port ${port}`);

      // Create and start the agent
      const character = {
        name: 'scenario-agent',
        bio: 'A test agent for scenario execution',
        plugins: ['@elizaos/plugin-sql'], // Only SQL plugin to avoid hanging
        settings: {
          secrets: {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
          },
        },
        style: {
          all: ['be helpful', 'be concise'],
          chat: ['be conversational'],
        },
      };

      console.log('🔄 Starting agent...');
      const agentRuntime = await localServer.startAgent(character);
      console.log(`✅ Agent started: ${agentRuntime.character.name} (${agentRuntime.character.id})`);
      agentId = agentRuntime.character.id || 'scenario-agent'; // Use the actual agent ID
    } else {
      localServer = server;
    }

    // Create API client
    const client = ElizaClient.create({
      baseUrl: `http://localhost:${port}`,
    });

    // Get servers to find default server
    const { servers } = await client.messaging.listServers();
    if (servers.length === 0) {
      throw new Error('No servers found');
    }
    const defaultServer = servers[0];

    // Create channel with correct parameters
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

    if (!channelResponse.ok) {
      throw new Error(`Channel creation failed: ${channelResponse.status}`);
    }

    const channelResult = await channelResponse.json();
    const channel = channelResult.data;

    // Add agent to channel
    await client.messaging.addAgentToChannel(channel.id, agentId as UUID);

    // Send message
    await client.messaging.postMessage(channel.id, input, { scenario: true });

    // Wait for response
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const messages = await client.messaging.getChannelMessages(channel.id, { limit: 10 });
      const agentMessage = messages.messages.find(msg =>
        msg.authorId === agentId &&
        new Date(msg.createdAt).getTime() > Date.now() - 10000
      );

      if (agentMessage) {
        return agentMessage.content;
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error('Timeout waiting for agent response');
  } catch (error) {
    throw new Error(`Natural language interaction failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Clean up local server if we created it
    if (localServer && !server) {
      try {
        await localServer.stop();
        console.log('✅ Server stopped');
      } catch (error) {
        console.log('⚠️ Error stopping server:', error instanceof Error ? error.message : String(error));
      }
    }
  }
}


