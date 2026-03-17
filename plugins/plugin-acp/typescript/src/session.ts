import { randomUUID } from "node:crypto";
// Import core session utilities from @elizaos/core
import {
  createSessionEntry,
  getSessionEntry,
  listSessionKeys,
  loadSessionStore,
  resolveDefaultSessionStorePath,
  type SessionEntry,
  upsertSessionEntry,
} from "@elizaos/core";
import type { AcpSession } from "./types.js";

/**
 * Interface for ACP session storage
 */
export type AcpSessionStore = {
  createSession: (params: {
    sessionKey: string;
    cwd: string;
    sessionId?: string;
  }) => AcpSession;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionByRunId: (runId: string) => AcpSession | undefined;
  setActiveRun: (
    sessionId: string,
    runId: string,
    abortController: AbortController,
  ) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
  clearAllSessionsForTest: () => void;
  /** Sync ACP session to the persistent core session store */
  syncToCoreStore?: (sessionId: string) => Promise<void>;
  /** Load ACP sessions from the core session store on startup */
  loadFromCoreStore?: () => Promise<void>;
};

/**
 * Create an in-memory session store
 */
export function createInMemorySessionStore(): AcpSessionStore {
  const sessions = new Map<string, AcpSession>();
  const runIdToSessionId = new Map<string, string>();

  const createSession: AcpSessionStore["createSession"] = (params) => {
    const sessionId = params.sessionId ?? randomUUID();
    const session: AcpSession = {
      sessionId,
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      createdAt: Date.now(),
      abortController: null,
      activeRunId: null,
    };
    sessions.set(sessionId, session);
    return session;
  };

  const getSession: AcpSessionStore["getSession"] = (sessionId) =>
    sessions.get(sessionId);

  const getSessionByRunId: AcpSessionStore["getSessionByRunId"] = (runId) => {
    const sessionId = runIdToSessionId.get(runId);
    return sessionId ? sessions.get(sessionId) : undefined;
  };

  const setActiveRun: AcpSessionStore["setActiveRun"] = (
    sessionId,
    runId,
    abortController,
  ) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.activeRunId = runId;
    session.abortController = abortController;
    runIdToSessionId.set(runId, sessionId);
  };

  const clearActiveRun: AcpSessionStore["clearActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.activeRunId = null;
    session.abortController = null;
  };

  const cancelActiveRun: AcpSessionStore["cancelActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session?.abortController) {
      return false;
    }
    session.abortController.abort();
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.abortController = null;
    session.activeRunId = null;
    return true;
  };

  const clearAllSessionsForTest: AcpSessionStore["clearAllSessionsForTest"] =
    () => {
      for (const session of sessions.values()) {
        session.abortController?.abort();
      }
      sessions.clear();
      runIdToSessionId.clear();
    };

  return {
    createSession,
    getSession,
    getSessionByRunId,
    setActiveRun,
    clearActiveRun,
    cancelActiveRun,
    clearAllSessionsForTest,
  };
}

/**
 * Options for creating a persistent session store
 */
export type PersistentSessionStoreOptions = {
  /** Path to the session store file. Defaults to resolveDefaultSessionStorePath() */
  storePath?: string;
  /** Agent ID for scoping sessions */
  agentId?: string;
  /** Whether to load existing sessions on creation */
  loadOnCreate?: boolean;
};

/**
 * Convert an ACP session to a core SessionEntry patch
 */
function acpSessionToEntryPatch(session: AcpSession): Partial<SessionEntry> {
  return {
    sessionId: session.sessionId,
    updatedAt: Date.now(),
    channel: "acp",
    // Store working directory in metadata-like field
    label: session.cwd ? `ACP: ${session.cwd}` : "ACP Session",
  };
}

/**
 * Convert a core SessionEntry to an ACP session
 */
function entryToAcpSession(
  entry: SessionEntry,
  sessionKey: string,
): AcpSession {
  // Extract cwd from label if it was stored there
  let cwd = process.cwd();
  if (entry.label?.startsWith("ACP: ")) {
    cwd = entry.label.slice(5);
  }

  return {
    sessionId: entry.sessionId,
    sessionKey,
    cwd,
    // SessionEntry uses updatedAt, not createdAt
    createdAt: entry.updatedAt,
    abortController: null,
    activeRunId: null,
  };
}

/**
 * Create a persistent session store that syncs with the core Eliza session store.
 *
 * This store maintains an in-memory cache for fast access and active run tracking,
 * while persisting session data to the Eliza session store file.
 */
export function createPersistentSessionStore(
  options: PersistentSessionStoreOptions = {},
): AcpSessionStore {
  const agentId = options.agentId ?? "main";
  const storePath =
    options.storePath ?? resolveDefaultSessionStorePath(agentId);

  // In-memory cache for sessions and active run tracking
  const sessions = new Map<string, AcpSession>();
  const runIdToSessionId = new Map<string, string>();
  const sessionIdToKey = new Map<string, string>();

  const createSession: AcpSessionStore["createSession"] = (params) => {
    const sessionId = params.sessionId ?? randomUUID();
    const session: AcpSession = {
      sessionId,
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      createdAt: Date.now(),
      abortController: null,
      activeRunId: null,
    };
    sessions.set(sessionId, session);
    sessionIdToKey.set(sessionId, params.sessionKey);

    // Sync to persistent store asynchronously
    void upsertSessionEntry({
      storePath,
      sessionKey: params.sessionKey,
      patch: acpSessionToEntryPatch(session),
    });

    return session;
  };

  const getSession: AcpSessionStore["getSession"] = (sessionId) =>
    sessions.get(sessionId);

  const getSessionByRunId: AcpSessionStore["getSessionByRunId"] = (runId) => {
    const sessionId = runIdToSessionId.get(runId);
    return sessionId ? sessions.get(sessionId) : undefined;
  };

  const setActiveRun: AcpSessionStore["setActiveRun"] = (
    sessionId,
    runId,
    abortController,
  ) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.activeRunId = runId;
    session.abortController = abortController;
    runIdToSessionId.set(runId, sessionId);
  };

  const clearActiveRun: AcpSessionStore["clearActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.activeRunId = null;
    session.abortController = null;
  };

  const cancelActiveRun: AcpSessionStore["cancelActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session?.abortController) {
      return false;
    }
    session.abortController.abort();
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.abortController = null;
    session.activeRunId = null;
    return true;
  };

  const clearAllSessionsForTest: AcpSessionStore["clearAllSessionsForTest"] =
    () => {
      for (const session of sessions.values()) {
        session.abortController?.abort();
      }
      sessions.clear();
      runIdToSessionId.clear();
      sessionIdToKey.clear();
    };

  const syncToCoreStore: AcpSessionStore["syncToCoreStore"] = async (
    sessionId,
  ) => {
    const session = sessions.get(sessionId);
    const sessionKey = sessionIdToKey.get(sessionId);
    if (!session || !sessionKey) {
      return;
    }
    await upsertSessionEntry({
      storePath,
      sessionKey,
      patch: acpSessionToEntryPatch(session),
    });
  };

  const loadFromCoreStore: AcpSessionStore["loadFromCoreStore"] = async () => {
    const store = loadSessionStore(storePath);
    const keys = listSessionKeys(storePath);

    for (const key of keys) {
      const entry = store[key];
      if (!entry || entry.channel !== "acp") {
        continue;
      }

      // Only load ACP sessions
      const session = entryToAcpSession(entry, key);
      sessions.set(session.sessionId, session);
      sessionIdToKey.set(session.sessionId, key);
    }
  };

  // Load existing sessions if requested
  if (options.loadOnCreate) {
    void loadFromCoreStore();
  }

  return {
    createSession,
    getSession,
    getSessionByRunId,
    setActiveRun,
    clearActiveRun,
    cancelActiveRun,
    clearAllSessionsForTest,
    syncToCoreStore,
    loadFromCoreStore,
  };
}

/**
 * Default session store instance (in-memory for backward compatibility)
 */
export const defaultAcpSessionStore = createInMemorySessionStore();

// Re-export core session utilities for plugins that need full session support
export {
  createSessionEntry,
  getSessionEntry,
  listSessionKeys,
  loadSessionStore,
  resolveDefaultSessionStorePath,
  type SessionEntry,
  upsertSessionEntry,
} from "@elizaos/core";
