import { apiClient as legacyClient } from './api';
import { createElizaClient } from './api-client-config';
import { wrapWithErrorHandling } from './api-error-bridge';

// Flag to control gradual migration
const MIGRATION_FLAGS = {
  USE_NEW_AGENTS_API: false,
  USE_NEW_MESSAGING_API: false,
  USE_NEW_MEMORY_API: false,
  USE_NEW_MEDIA_API: false,
  USE_NEW_SYSTEM_API: false,
  USE_NEW_AUDIO_API: false,
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
    // Agent services
    getAgents: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(newClient.agents.listAgents.bind(newClient.agents))
      : legacyClient.getAgents,
    getAgent: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(newClient.agents.getAgent.bind(newClient.agents))
      : legacyClient.getAgent,
    startAgent: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(newClient.agents.startAgent.bind(newClient.agents))
      : legacyClient.startAgent,
    stopAgent: MIGRATION_FLAGS.USE_NEW_AGENTS_API
      ? wrapWithErrorHandling(newClient.agents.stopAgent.bind(newClient.agents))
      : legacyClient.stopAgent,

    // Messaging services
    getServers: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(
          newClient.messaging?.getServers?.bind(newClient.messaging) ||
            (() => {
              throw new Error('Messaging service not available');
            })
        )
      : legacyClient.getServers,
    getChannels: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(
          newClient.messaging?.getChannels?.bind(newClient.messaging) ||
            (() => {
              throw new Error('Messaging service not available');
            })
        )
      : legacyClient.getChannels,
    getChannelMessages: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(
          newClient.messaging?.getChannelMessages?.bind(newClient.messaging) ||
            (() => {
              throw new Error('Messaging service not available');
            })
        )
      : legacyClient.getChannelMessages,
    postMessageToChannel: MIGRATION_FLAGS.USE_NEW_MESSAGING_API
      ? wrapWithErrorHandling(
          newClient.messaging?.sendMessage?.bind(newClient.messaging) ||
            (() => {
              throw new Error('Messaging service not available');
            })
        )
      : legacyClient.postMessageToChannel,

    // Memory services
    getAgentMemories: MIGRATION_FLAGS.USE_NEW_MEMORY_API
      ? wrapWithErrorHandling(
          newClient.memory?.getAgentMemories?.bind(newClient.memory) ||
            (() => {
              throw new Error('Memory service not available');
            })
        )
      : legacyClient.getAgentMemories,

    // Media services
    uploadAgentMedia: MIGRATION_FLAGS.USE_NEW_MEDIA_API
      ? wrapWithErrorHandling(
          newClient.media?.uploadAgentMedia?.bind(newClient.media) ||
            (() => {
              throw new Error('Media service not available');
            })
        )
      : legacyClient.uploadAgentMedia,
    uploadChannelMedia: MIGRATION_FLAGS.USE_NEW_MEDIA_API
      ? wrapWithErrorHandling(
          newClient.media?.uploadChannelMedia?.bind(newClient.media) ||
            (() => {
              throw new Error('Media service not available');
            })
        )
      : legacyClient.uploadChannelMedia,

    // Audio services
    ttsStream: MIGRATION_FLAGS.USE_NEW_AUDIO_API
      ? wrapWithErrorHandling(
          newClient.audio?.generateSpeech?.bind(newClient.audio) ||
            (() => {
              throw new Error('Audio service not available');
            })
        )
      : legacyClient.ttsStream,
    transcribeAudio: MIGRATION_FLAGS.USE_NEW_AUDIO_API
      ? wrapWithErrorHandling(
          newClient.audio?.transcribeAudio?.bind(newClient.audio) ||
            (() => {
              throw new Error('Audio service not available');
            })
        )
      : legacyClient.transcribeAudio,

    // System services
    ping: MIGRATION_FLAGS.USE_NEW_SYSTEM_API
      ? wrapWithErrorHandling(
          newClient.system?.ping?.bind(newClient.system) ||
            (() => {
              throw new Error('System service not available');
            })
        )
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
