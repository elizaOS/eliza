/**
 * Session and utility functions for the agent orchestrator.
 *
 * @module utils
 */

// Local orchestrator-specific utilities
// Re-export core session utilities for plugins that need full session support
export {
  buildAcpSessionKey,
  // Session key building/parsing from core
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  buildAgentSessionKey,
  buildGroupHistoryKey,
  buildSessionKey,
  buildSubagentSessionKey,
  createSendPolicyProvider,
  // Session entry utilities
  createSessionEntry,
  // Session providers
  createSessionProvider,
  createSessionSkillsProvider,
  createSubagentSessionKey,
  deleteSessionEntry,
  extractAgentIdFromSessionKey,
  extractSessionContext,
  formatDurationShort,
  formatTokenCount,
  getSessionEntry,
  getSessionProviders,
  hashToUUID,
  isAcpSessionKey,
  isCoreSubagentSessionKey,
  isSubagentSessionKey,
  isValidSessionEntry,
  listSessionKeys,
  // Session store operations
  loadSessionStore,
  mergeDeliveryContext,
  mergeSessionEntry,
  normalizeAccountId,
  normalizeAgentId,
  normalizeCoreAgentId,
  normalizeDeliveryContext,
  normalizeMainKey,
  normalizeSessionKey,
  parseAgentSessionKey,
  parseSessionKey,
  resolveAgentIdFromSessionKey,
  resolveAgentSessionsDir,
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptPath,
  // Session paths
  resolveStateDir,
  resolveStorePath,
  resolveThreadParentSessionKey,
  resolveThreadSessionKeys,
  type SessionDeliveryContext,
  // Session types
  type SessionEntry,
  type SessionResolution,
  SessionStateManager,
  type SessionStore,
  saveSessionStore,
  sessionKeyToRoomId,
  toAgentRequestSessionKey,
  toAgentStoreSessionKey,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "./session.js";
