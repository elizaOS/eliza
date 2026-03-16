/**
 * Session and utility functions for the agent orchestrator.
 *
 * @module utils
 */

// Local orchestrator-specific utilities
export {
  buildSessionKey,
  createSubagentSessionKey,
  extractAgentIdFromSessionKey,
  formatDurationShort,
  formatTokenCount,
  hashToUUID,
  isSubagentSessionKey,
  mergeDeliveryContext,
  normalizeAgentId,
  normalizeDeliveryContext,
  normalizeSessionKey,
  parseSessionKey,
  sessionKeyToRoomId,
} from "./session.js";

// Re-export core session utilities for plugins that need full session support
export {
  // Session key building/parsing from core
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  buildAgentPeerSessionKey,
  buildAcpSessionKey,
  buildSubagentSessionKey,
  parseAgentSessionKey,
  isAcpSessionKey,
  isCoreSubagentSessionKey,
  normalizeCoreAgentId,
  normalizeMainKey,
  normalizeAccountId,
  toAgentRequestSessionKey,
  toAgentStoreSessionKey,
  resolveAgentIdFromSessionKey,
  resolveThreadParentSessionKey,
  resolveThreadSessionKeys,
  buildGroupHistoryKey,
  // Session types
  type SessionEntry,
  type SessionStore,
  type SessionDeliveryContext,
  type SessionResolution,
  // Session store operations
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
  getSessionEntry,
  upsertSessionEntry,
  deleteSessionEntry,
  listSessionKeys,
  // Session paths
  resolveStateDir,
  resolveAgentSessionsDir,
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptPath,
  resolveStorePath,
  // Session providers
  createSessionProvider,
  createSessionSkillsProvider,
  createSendPolicyProvider,
  getSessionProviders,
  extractSessionContext,
  SessionStateManager,
  // Session entry utilities
  createSessionEntry,
  mergeSessionEntry,
  isValidSessionEntry,
} from "./session.js";
