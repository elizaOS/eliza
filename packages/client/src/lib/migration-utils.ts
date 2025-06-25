import { apiClient as legacyClient } from './api';
import { createElizaClient } from './api-client-config';
import { wrapWithErrorHandling } from './api-error-bridge';

// Flag to control gradual migration
const MIGRATION_FLAGS = {
  USE_NEW_AGENTS_API: true, // ENABLED: Phase 3.1 - Agent Services Migration
  USE_NEW_MESSAGING_API: true, // ENABLED: Phase 3.2 - Messaging Services Migration (Fixed)
  USE_NEW_MEMORY_API: true, // ENABLED: Phase 3.3 - Memory Services Migration
  USE_NEW_MEDIA_API: true, // ENABLED: Phase 3.4 - Media Services Migration
  USE_NEW_SYSTEM_API: true, // ENABLED: Phase 3.5 - System Services Migration
  USE_NEW_AUDIO_API: true, // ENABLED: Phase 3.4 - Audio Services Migration
  USE_NEW_ENVIRONMENT_API: true, // ENABLED: Phase 4.2 - Environment Settings Migration
};

export { MIGRATION_FLAGS };

// Create a singleton instance of the new client
let elizaClientInstance: ReturnType<typeof createElizaClient> | null = null;

function getElizaClient() {
  if (!elizaClientInstance) {
    elizaClientInstance = createElizaClient();
  }
  return elizaClientInstance;
}

// Helper to gradually switch APIs
export function createHybridClient() {
  const newClient = getElizaClient();

  return {
    // Agent services - using NEW API client only
    getAgents: wrapWithErrorHandling(async () => {
      if (!newClient.agents?.listAgents) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.listAgents();
      // Adapt from { agents: Agent[] } to { data: { agents: Agent[] } }
      return { data: result };
    }),
    getAgent: wrapWithErrorHandling(async (agentId: string) => {
      if (!newClient.agents?.getAgent) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.getAgent(agentId);
      // Adapt from Agent to { data: Agent }
      return { data: result };
    }),
    startAgent: wrapWithErrorHandling(async (agentId: string) => {
      if (!newClient.agents?.startAgent) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.startAgent(agentId);
      // Adapt from { status: string } to expected format
      return { data: { id: agentId, status: result.status } };
    }),
    stopAgent: wrapWithErrorHandling(async (agentId: string) => {
      if (!newClient.agents?.stopAgent) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.stopAgent(agentId);
      // Adapt from { status: string } to expected format
      return { data: { message: `Agent ${result.status}` } };
    }),

    // Agent Management services - using NEW API client only
    createAgent: wrapWithErrorHandling(
      async (params: { characterPath?: string; characterJson?: any }) => {
        if (!newClient.agents?.createAgent) {
          throw new Error('Agents service not available');
        }
        // Convert legacy params to new format
        const createParams = params.characterJson ? { agent: params.characterJson } : params;
        const result = await newClient.agents.createAgent(createParams);
        // Adapt from Agent to { success: boolean; data: Agent }
        return { success: true, data: result };
      }
    ),
    updateAgent: wrapWithErrorHandling(async (agentId: string, agentData: any) => {
      if (!newClient.agents?.updateAgent) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.updateAgent(agentId, agentData);
      // Adapt from Agent to { success: boolean; data: Agent }
      return { success: true, data: result };
    }),
    deleteAgent: wrapWithErrorHandling(async (agentId: string) => {
      if (!newClient.agents?.deleteAgent) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.deleteAgent(agentId);
      // Return the success response format
      return result;
    }),
    getAgentPanels: wrapWithErrorHandling(async (agentId: string) => {
      if (!newClient.agents?.getAgentPanels) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.getAgentPanels(agentId);
      // Adapt from { panels: AgentPanel[] } to { success: boolean; data: AgentPanel[] }
      return { success: true, data: result.panels };
    }),
    getAgentLogs: wrapWithErrorHandling(async (agentId: string, options?: any) => {
      if (!newClient.agents?.getAgentLogs) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.getAgentLogs(agentId, options);
      // The new API client returns logs directly from server data field
      return { data: result };
    }),
    deleteAgentLog: wrapWithErrorHandling(async (agentId: string, logId: string) => {
      if (!newClient.agents?.deleteAgentLog) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.deleteAgentLog(agentId, logId);
      // Return the success response
      return result;
    }),

    // Messaging services - using NEW API client only
    getServers: wrapWithErrorHandling(async () => {
      if (!newClient.messaging?.listServers) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.listServers();
      // Adapt from { servers: MessageServer[] } to { data: { servers: MessageServer[] } }
      return { data: { servers: result.servers } };
    }),
    getChannelsForServer: wrapWithErrorHandling(async (serverId: string) => {
      if (!newClient.messaging?.getServerChannels) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.getServerChannels(serverId);
      // Adapt from { channels: MessageChannel[] } to { data: { channels: MessageChannel[] } }
      return { data: { channels: result.channels } };
    }),
    getChannels: wrapWithErrorHandling(async (serverId: string) => {
      if (!newClient.messaging?.getServerChannels) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.getServerChannels(serverId);
      // Adapt from { channels: MessageChannel[] } to { data: { channels: MessageChannel[] } }
      return { data: { channels: result.channels } };
    }),
    getOrCreateDmChannel: wrapWithErrorHandling(
      async (targetUserId: string, currentUserId: string) => {
        if (!newClient.messaging?.getOrCreateDmChannel) {
          throw new Error('Messaging service not available');
        }
        const result = await newClient.messaging.getOrCreateDmChannel({
          participantIds: [currentUserId, targetUserId],
        });
        // Adapt from MessageChannel to { data: MessageChannel }
        return { data: result };
      }
    ),
    createCentralGroupChat: wrapWithErrorHandling(async (params: any) => {
      if (!newClient.messaging?.createGroupChannel) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.createGroupChannel(params);
      // Adapt from MessageChannel to { data: MessageChannel }
      return { data: result };
    }),
    getChannelMessages: wrapWithErrorHandling(
      async (channelId: string, options?: { limit?: number; before?: number }) => {
        if (!newClient.messaging?.getChannelMessages) {
          throw new Error('Messaging service not available');
        }

        // Convert parameters from legacy format to new format
        const params: any = {};
        if (options?.limit) params.limit = options.limit;
        if (options?.before) {
          // Convert timestamp number to Date
          params.before = new Date(options.before).toISOString();
        }

        const result = await newClient.messaging.getChannelMessages(channelId, params);
        // Adapt from { messages: Message[] } to { data: { messages: ServerMessage[] } }
        return { data: { messages: result.messages } };
      }
    ),
    postMessageToChannel: wrapWithErrorHandling(async (channelId: string, payload: any) => {
      if (!newClient.messaging?.postMessage) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.postMessage(
        channelId,
        payload.text || payload.content,
        payload.metadata
      );
      // Adapt from Message to { data: Message }
      return { data: result };
    }),
    getChannelDetails: wrapWithErrorHandling(async (channelId: string) => {
      if (!newClient.messaging?.getChannelDetails) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.getChannelDetails(channelId);
      // Adapt from MessageChannel to { data: MessageChannel }
      return { data: result };
    }),
    getChannelParticipants: wrapWithErrorHandling(async (channelId: string) => {
      if (!newClient.messaging?.getChannelParticipants) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.getChannelParticipants(channelId);
      // The API client already handles the response transformation
      // Server returns { success: true, data: UUID[] }
      // API client returns { participants: UUID[] }
      // We need to return { success: boolean, data: UUID[] }
      return { success: true, data: result.participants };
    }),
    deleteChannelMessage: wrapWithErrorHandling(async (channelId: string, messageId: string) => {
      if (!newClient.messaging?.deleteMessage) {
        // Fallback to legacy API
        return await legacyClient.deleteChannelMessage(channelId, messageId);
      }
      try {
        const result = await newClient.messaging.deleteMessage(channelId, messageId);
        return result;
      } catch (error) {
        // Add fallback to legacy API
        return await legacyClient.deleteChannelMessage(channelId, messageId);
      }
    }),
    clearChannelMessages: wrapWithErrorHandling(async (channelId: string) => {
      if (!newClient.messaging?.clearChannelHistory) {
        // Fallback to legacy API
        return await legacyClient.clearChannelMessages(channelId);
      }
      try {
        const result = await newClient.messaging.clearChannelHistory(channelId);
        return result;
      } catch (error) {
        // Add fallback to legacy API
        return await legacyClient.clearChannelMessages(channelId);
      }
    }),
    deleteChannel: wrapWithErrorHandling(async (channelId: string) => {
      if (!newClient.messaging?.deleteChannel) {
        throw new Error('Messaging service not available');
      }
      try {
        const result = await newClient.messaging.deleteChannel(channelId);
        return result;
      } catch (error) {
        // Add fallback to legacy API
        return await legacyClient.deleteChannel(channelId);
      }
    }),
    updateChannel: wrapWithErrorHandling(async (channelId: string, params: any) => {
      if (!newClient.messaging?.updateChannel) {
        console.warn('New messaging service not available, falling back to legacy API');
        // Fallback to legacy API
        return await legacyClient.updateChannel(channelId, params);
      }
      try {
        const result = await newClient.messaging.updateChannel(channelId, params);
        // Ensure consistent format with expected return type
        return { success: result.success, data: result.data };
      } catch (error) {
        console.error('New API updateChannel failed, falling back to legacy:', error);
        // Fallback to legacy API if new API fails
        return await legacyClient.updateChannel(channelId, params);
      }
    }),

    // Memory services - using NEW API client only
    getAgentMemories: wrapWithErrorHandling(
      async (agentId: string, channelId?: string, tableName?: string, includeEmbedding = false) => {
        if (!newClient.memory?.getAgentMemories) {
          throw new Error('Memory service not available');
        }

        // Convert legacy parameters to new format
        const params: any = {};
        if (tableName) params.tableName = tableName;
        if (channelId) params.roomId = channelId; // Map channelId to roomId
        if (includeEmbedding) params.includeEmbedding = includeEmbedding;

        const result = await newClient.memory.getAgentMemories(agentId, params);
        // Adapt from { memories: Memory[] } to { data: { memories: ClientMemory[] } }
        return { data: { memories: result.memories } };
      }
    ),
    deleteAgentMemory: wrapWithErrorHandling(async (agentId: string, memoryId: string) => {
      if (!newClient.memory?.deleteMemory) {
        throw new Error('Memory service not available');
      }
      const result = await newClient.memory.deleteMemory(agentId, memoryId);
      return { success: result.success, data: { deleted: 1 } };
    }),
    deleteAllAgentMemories: wrapWithErrorHandling(async (agentId: string, roomId: string) => {
      if (!newClient.memory?.clearRoomMemories) {
        throw new Error('Memory service not available');
      }
      const result = await newClient.memory.clearRoomMemories(agentId, roomId);
      // Adapt from { deleted: number } to expected format
      return { data: { deleted: result.deleted } };
    }),
    updateAgentMemory: wrapWithErrorHandling(
      async (agentId: string, memoryId: string, memoryData: any) => {
        if (!newClient.memory?.updateMemory) {
          throw new Error('Memory service not available');
        }
        const result = await newClient.memory.updateMemory(agentId, memoryId, memoryData);
        // Adapt from Memory to { data: Memory }
        return { data: result };
      }
    ),

    // Media services - using NEW API client only
    uploadAgentMedia: wrapWithErrorHandling(async (agentId: string, file: File) => {
      if (!newClient.media?.uploadAgentMedia) {
        throw new Error('Media service not available');
      }
      const result = await newClient.media.uploadAgentMedia(agentId, {
        file: file,
        filename: file.name,
      });
      // Adapt from MediaUploadResponse to { success: boolean; data: { url: string; type: string } }
      return {
        success: true,
        data: {
          url: result.url,
          type: result.contentType || file.type,
        },
      };
    }),
    uploadChannelMedia: wrapWithErrorHandling(async (channelId: string, file: File) => {
      if (!newClient.media?.uploadChannelMedia) {
        throw new Error('Media service not available');
      }
      const result = await newClient.media.uploadChannelMedia(channelId, file);
      // Adapt from ChannelUploadResponse to expected format
      return {
        success: true,
        data: {
          url: result.url,
          type: result.contentType || file.type,
        },
      };
    }),

    // Audio services - using NEW API client only
    ttsStream: wrapWithErrorHandling(async (agentId: string, text: string) => {
      if (!newClient.audio?.generateSpeech) {
        throw new Error('Audio service not available');
      }
      const result = await newClient.audio.generateSpeech(agentId, { text });
      // Convert audio data to Blob
      // Assuming result.audio is base64 data
      const audioData = atob(result.audio);
      const bytes = new Uint8Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        bytes[i] = audioData.charCodeAt(i);
      }
      return new Blob([bytes], { type: 'audio/wav' });
    }),
    transcribeAudio: wrapWithErrorHandling(async (agentId: string, audioBlob: Blob) => {
      if (!newClient.audio?.transcribe) {
        throw new Error('Audio service not available');
      }
      const result = await newClient.audio.transcribe(agentId, { audio: audioBlob });
      // Adapt from TranscriptionResponse to { success: boolean; data: { text: string } }
      return {
        success: true,
        data: {
          text: result.text || result.transcription || '',
        },
      };
    }),

    // System services - using NEW API client only
    ping: wrapWithErrorHandling(async () => {
      // Remove this fake implementation - either implement real ping endpoint or remove ping functionality
      throw new Error(
        'Ping functionality not implemented in new API - this should be removed or implemented properly'
      );
    }),

    // Environment services - using NEW API client only
    getLocalEnvs: wrapWithErrorHandling(async () => {
      if (!newClient.system?.getEnvironment) {
        throw new Error('System service not available');
      }
      const result = await newClient.system.getEnvironment();
      // Adapt from Record<string, string> to { data: Record<string, string> }
      return { data: result };
    }),
    updateLocalEnvs: wrapWithErrorHandling(async (envs: Record<string, string>) => {
      if (!newClient.system?.updateLocalEnvironment) {
        throw new Error('System service not available');
      }
      const result = await newClient.system.updateLocalEnvironment(envs);
      // Adapt from { success: boolean; message: string } to expected format
      return { success: result.success, message: result.message };
    }),

    // Global Logs services - using NEW API client only
    getGlobalLogs: wrapWithErrorHandling(async (params: any) => {
      if (!newClient.system?.getGlobalLogs) {
        throw new Error('System service not available');
      }
      const result = await newClient.system.getGlobalLogs(params);
      return result;
    }),
    deleteGlobalLogs: wrapWithErrorHandling(async () => {
      if (!newClient.system?.deleteGlobalLogs) {
        throw new Error('System service not available');
      }
      const result = await newClient.system.deleteGlobalLogs();
      return result;
    }),

    // Server Management services - using NEW API client only
    getAgentsForServer: wrapWithErrorHandling(async (serverId: string) => {
      if (!newClient.agents?.getAgentsForServer) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.getAgentsForServer(serverId);
      return result;
    }),
    addAgentToServer: wrapWithErrorHandling(async (serverId: string, agentId: string) => {
      if (!newClient.agents?.addAgentToServer) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.addAgentToServer(serverId, agentId);
      return result;
    }),
    removeAgentFromServer: wrapWithErrorHandling(async (serverId: string, agentId: string) => {
      if (!newClient.agents?.removeAgentFromServer) {
        throw new Error('Agents service not available');
      }
      const result = await newClient.agents.removeAgentFromServer(serverId, agentId);
      return result;
    }),

    // Channel Management services - using NEW API client only
    getChannelTitle: wrapWithErrorHandling(async (channelId: string, agentId?: string) => {
      if (!newClient.messaging?.generateChannelTitle) {
        throw new Error('Messaging service not available');
      }
      const result = await newClient.messaging.generateChannelTitle(channelId);
      // Adapt from { title: string } to expected format
      return {
        success: true,
        data: {
          title: result.title,
          channelId: channelId,
        },
      };
    }),

    // Additional Memory/Log Management services - using NEW API client only
    deleteLog: wrapWithErrorHandling(async (logId: string) => {
      if (!newClient.system?.deleteLog) {
        throw new Error('System service not available');
      }
      await newClient.system.deleteLog(logId);
      return { success: true };
    }),
    deleteGroupMemory: wrapWithErrorHandling(async (serverId: string, memoryId: string) => {
      if (!newClient.messaging?.deleteMessage) {
        throw new Error('Messaging service not available');
      }
      // Group memory deletion is actually a message deletion in the messaging system
      // Note: serverId is actually the channelId in this context
      const result = await newClient.messaging.deleteMessage(serverId, memoryId);
      return { success: result.success };
    }),
    clearGroupChat: wrapWithErrorHandling(async (serverId: string) => {
      if (!newClient.messaging?.clearChannelHistory) {
        throw new Error('Messaging service not available');
      }
      // Clear group chat is actually clearing channel history in the messaging system
      const result = await newClient.messaging.clearChannelHistory(serverId);
      return { success: true, deleted: result.deleted };
    }),
    getAgentInternalMemories: wrapWithErrorHandling(
      async (agentId: string, agentPerspectiveRoomId: string, includeEmbedding?: boolean) => {
        if (!newClient.memory?.getAgentInternalMemories) {
          throw new Error('Memory service not available');
        }
        const result = await newClient.memory.getAgentInternalMemories(
          agentId,
          agentPerspectiveRoomId,
          includeEmbedding
        );
        return result; // Already in correct format
      }
    ),
    deleteAgentInternalMemory: wrapWithErrorHandling(async (agentId: string, memoryId: string) => {
      if (!newClient.memory?.deleteAgentInternalMemory) {
        throw new Error('Memory service not available');
      }
      const result = await newClient.memory.deleteAgentInternalMemory(agentId, memoryId);
      return { success: result.success };
    }),
    deleteAllAgentInternalMemories: wrapWithErrorHandling(
      async (agentId: string, agentPerspectiveRoomId: string) => {
        if (!newClient.memory?.deleteAllAgentInternalMemories) {
          throw new Error('Memory service not available');
        }
        const result = await newClient.memory.deleteAllAgentInternalMemories(
          agentId,
          agentPerspectiveRoomId
        );
        return { success: result.success };
      }
    ),
    updateAgentInternalMemory: wrapWithErrorHandling(
      async (agentId: string, memoryId: string, memoryData: any) => {
        if (!newClient.memory?.updateAgentInternalMemory) {
          throw new Error('Memory service not available');
        }
        const result = await newClient.memory.updateAgentInternalMemory(
          agentId,
          memoryId,
          memoryData
        );
        return { data: result };
      }
    ),

    // All methods now use the new @elizaos/api-client - no legacy fallbacks!
  };
}

// Helper to refresh the client instance (useful when API key changes)
export function refreshElizaClient(): void {
  elizaClientInstance = null;
}

// Helper to toggle migration flags (useful for testing)
export function setMigrationFlag(flag: keyof typeof MIGRATION_FLAGS, value: boolean): void {
  MIGRATION_FLAGS[flag] = value;
  console.log(`Migration flag ${flag} set to ${value}`);
}

// Helper to get current migration status
export function getMigrationStatus() {
  return { ...MIGRATION_FLAGS };
}
