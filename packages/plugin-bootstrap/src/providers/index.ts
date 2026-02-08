export { actionsProvider } from './actions';
export { actionStateProvider } from './actionState';
export { anxietyProvider } from './anxiety';
export { attachmentsProvider } from './attachments';
export { capabilitiesProvider } from './capabilities';
export { characterProvider } from './character';
export { choiceProvider } from './choice';
export { entitiesProvider } from './entities';
export { evaluatorsProvider } from './evaluators';
export { factsProvider } from './facts';
export { providersProvider } from './providers';
export { recentMessagesProvider } from './recentMessages';
export { relationshipsProvider } from './relationships';
export { roleProvider } from './roles';
export { settingsProvider } from './settings';
export { timeProvider } from './time';
export { worldProvider } from './world';

// Shared caching utilities for cross-provider optimization
export {
    // Agent-specific cache functions
    getCachedRoom,
    getCachedWorld,
    getCachedEntitiesForRoom,
    getCachedWorldSettings,
    extractWorldSettings,
    invalidateRoomCache,
    invalidateWorldCache,
    invalidateEntitiesCache,
    // Cross-agent cache functions (by external IDs like Discord guildId/channelId)
    getCachedRoomByExternalId,
    getCachedSettingsByServerId,
    invalidateRoomCacheByExternalId,
    invalidateWorldCacheByServerId,
    // Negative caching
    hasNoServerId,
    markNoServerId,
    hasNoSettings,
    markNoSettings,
    // Utilities
    withTimeout,
    getCacheStats,
} from './shared-cache';
