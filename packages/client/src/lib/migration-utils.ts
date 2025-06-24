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
    // Agent services - with data shape adapters
    getAgents: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(async () => {
          const result = await newClient.agents.listAgents();
          // Adapt from { agents: Agent[] } to { data: { agents: Agent[] } }
          return { data: result };
        })
      : legacyClient.getAgents,
    getAgent: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(async (agentId: string) => {
          const result = await newClient.agents.getAgent(agentId);
          // Adapt from Agent to { data: Agent }
          return { data: result };
        })
      : legacyClient.getAgent,
    startAgent: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(async (agentId: string) => {
          const result = await newClient.agents.startAgent(agentId);
          // Adapt from { status: string } to expected format
          return { data: { id: agentId, status: result.status } };
        })
      : legacyClient.startAgent,
    stopAgent: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(async (agentId: string) => {
          const result = await newClient.agents.stopAgent(agentId);
          // Adapt from { status: string } to expected format
          return { data: { message: `Agent ${result.status}` } };
        })
      : legacyClient.stopAgent,

    // Messaging services
    getServers: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async () => {
          if (!newClient.messaging?.listServers) {
            throw new Error('Messaging service not available');
          }
          const result = await newClient.messaging.listServers();
          // Adapt from { servers: MessageServer[] } to { data: { servers: MessageServer[] } }
          return { data: { servers: result.servers } };
        })
      : legacyClient.getServers,
    getChannelsForServer: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (serverId: string) => {
          if (!newClient.messaging?.getServerChannels) {
            throw new Error('Messaging service not available');
          }
          const result = await newClient.messaging.getServerChannels(serverId);
          // Adapt from { channels: MessageChannel[] } to { data: { channels: MessageChannel[] } }
          return { data: { channels: result.channels } };
        })
      : legacyClient.getChannelsForServer,
    getChannels: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (serverId: string) => {
          if (!newClient.messaging?.getServerChannels) {
            throw new Error('Messaging service not available');
          }
          const result = await newClient.messaging.getServerChannels(serverId);
          // Adapt from { channels: MessageChannel[] } to { data: { channels: MessageChannel[] } }
          return { data: { channels: result.channels } };
        })
      : legacyClient.getChannels,
    getOrCreateDmChannel: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (targetUserId: string, currentUserId: string) => {
          if (!newClient.messaging?.getOrCreateDmChannel) {
            throw new Error('Messaging service not available');
          }
          const result = await newClient.messaging.getOrCreateDmChannel({ 
            participantIds: [currentUserId, targetUserId] 
          });
          // Adapt from MessageChannel to { data: MessageChannel }
          return { data: result };
        })
      : legacyClient.getOrCreateDmChannel,
    createCentralGroupChat: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (params: any) => {
          if (!newClient.messaging?.createGroupChannel) {
            throw new Error('Messaging service not available');
          }
          const result = await newClient.messaging.createGroupChannel(params);
          // Adapt from MessageChannel to { data: MessageChannel }
          return { data: result };
        })
      : legacyClient.createCentralGroupChat,
    getChannelMessages: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string, options?: { limit?: number; before?: number }) => {
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
        })
      : legacyClient.getChannelMessages,
    postMessageToChannel: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string, payload: any) => {
          const result = await newClient.messaging.postMessage(channelId, payload.text || payload.content, payload.metadata);
          // Adapt from Message to { data: Message }
          return { data: result };
        })
      : legacyClient.postMessageToChannel,
    getChannelDetails: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string) => {
          const result = await newClient.messaging.getChannelDetails(channelId);
          // Adapt from MessageChannel to { data: MessageChannel }
          return { data: result };
        })
      : legacyClient.getChannelDetails,
    getChannelParticipants: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string) => {
          const result = await newClient.messaging.getChannelParticipants(channelId);
          // Adapt from { participants: ChannelParticipant[] } to { data: ChannelParticipant[] }
          return { data: result.participants };
        })
      : legacyClient.getChannelParticipants,
    deleteChannelMessage: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string, messageId: string) => {
          const result = await newClient.messaging.deleteMessage(messageId);
          // Adapt from { success: boolean } to expected format
          return { data: { success: result.success } };
        })
      : legacyClient.deleteChannelMessage,
    clearChannelMessages: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string) => {
          const result = await newClient.messaging.clearChannelHistory(channelId);
          // Adapt from { deleted: number } to expected format
          return { data: { deleted: result.deleted } };
        })
      : legacyClient.clearChannelMessages,
    getOrCreateDmChannel: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (targetUserId: string, currentUserId: string) => {
          const result = await newClient.messaging.getOrCreateDmChannel({ targetUserId, currentUserId });
          // Adapt from MessageChannel to { data: MessageChannel }
          return { data: result };
        })
      : legacyClient.getOrCreateDmChannel,
    deleteChannel: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (channelId: string) => {
          const result = await newClient.messaging.deleteChannel(channelId);
          // Adapt from { success: boolean } to expected format
          return { data: { success: result.success } };
        })
      : legacyClient.deleteChannel,
    createCentralGroupChat: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(async (params: any) => {
          const result = await newClient.messaging.createGroupChannel(params);
          // Adapt from MessageChannel to { data: MessageChannel }
          return { data: result };
        })
      : legacyClient.createCentralGroupChat,

    // Memory services
    getAgentMemories: MIGRATION_FLAGS.USE_NEW_MEMORY_API
      ? wrapWithErrorHandling(async (agentId: string, channelId?: string, tableName?: string, includeEmbedding = false) => {
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
        })
      : legacyClient.getAgentMemories,
    deleteAgentMemory: MIGRATION_FLAGS.USE_NEW_MEMORY_API
      ? wrapWithErrorHandling(async (agentId: string, memoryId: string) => {
          if (!newClient.memory?.updateMemory) {
            throw new Error('Memory service not available');
          }
          // Note: New API doesn't have direct delete, might need to use updateMemory with deletion flag
          // For now, throw error to indicate this needs implementation
          throw new Error('Delete memory not yet implemented in new API');
        })
      : legacyClient.deleteAgentMemory,
    deleteAllAgentMemories: MIGRATION_FLAGS.USE_NEW_MEMORY_API
      ? wrapWithErrorHandling(async (agentId: string, roomId: string) => {
          if (!newClient.memory?.clearRoomMemories) {
            throw new Error('Memory service not available');
          }
          const result = await newClient.memory.clearRoomMemories(agentId, roomId);
          // Adapt from { deleted: number } to expected format
          return { data: { deleted: result.deleted } };
        })
      : legacyClient.deleteAllAgentMemories,
    updateAgentMemory: MIGRATION_FLAGS.USE_NEW_MEMORY_API
      ? wrapWithErrorHandling(async (agentId: string, memoryId: string, memoryData: any) => {
          if (!newClient.memory?.updateMemory) {
            throw new Error('Memory service not available');
          }
          const result = await newClient.memory.updateMemory(agentId, memoryId, memoryData);
          // Adapt from Memory to { data: Memory }
          return { data: result };
        })
      : legacyClient.updateAgentMemory,

    // Media services
    uploadAgentMedia: MIGRATION_FLAGS.USE_NEW_MEDIA_API
      ? wrapWithErrorHandling(async (agentId: string, file: File) => {
          if (!newClient.media?.uploadAgentMedia) {
            throw new Error('Media service not available');
          }
          const result = await newClient.media.uploadAgentMedia(agentId, {
            file: file,
            filename: file.name
          });
          // Adapt from MediaUploadResponse to { success: boolean; data: { url: string; type: string } }
          return { 
            success: true, 
            data: { 
              url: result.url, 
              type: result.contentType || file.type 
            } 
          };
        })
      : legacyClient.uploadAgentMedia,
    uploadChannelMedia: MIGRATION_FLAGS.USE_NEW_MEDIA_API
      ? wrapWithErrorHandling(async (channelId: string, file: File) => {
          if (!newClient.media?.uploadChannelMedia) {
            throw new Error('Media service not available');
          }
          const result = await newClient.media.uploadChannelMedia(channelId, file);
          // Adapt from ChannelUploadResponse to expected format
          return { 
            success: true, 
            data: { 
              url: result.url, 
              type: result.contentType || file.type 
            } 
          };
        })
      : legacyClient.uploadChannelMedia,

    // Audio services
    ttsStream: MIGRATION_FLAGS.USE_NEW_AUDIO_API
      ? wrapWithErrorHandling(async (agentId: string, text: string) => {
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
        })
      : legacyClient.ttsStream,
    transcribeAudio: MIGRATION_FLAGS.USE_NEW_AUDIO_API
      ? wrapWithErrorHandling(async (agentId: string, audioBlob: Blob) => {
          if (!newClient.audio?.transcribe) {
            throw new Error('Audio service not available');
          }
          const result = await newClient.audio.transcribe(agentId, { audio: audioBlob });
          // Adapt from TranscriptionResponse to { success: boolean; data: { text: string } }
          return { 
            success: true, 
            data: { 
              text: result.text || result.transcription || '' 
            } 
          };
        })
      : legacyClient.transcribeAudio,

    // System services
    ping: MIGRATION_FLAGS.USE_NEW_SYSTEM_API
      ? wrapWithErrorHandling(async () => {
          // New API doesn't have ping endpoint, return mock response
          return { pong: true, timestamp: Date.now() };
        })
      : legacyClient.ping,

    // Keep all other legacy methods for now
    ...legacyClient,
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
