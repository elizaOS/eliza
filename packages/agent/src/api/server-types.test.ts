/**
 * Pins the agent HTTP `ServerState` TypeScript contracts and the DTO shapes
 * the dashboard and connector dispatch loop consume. The module is types-only —
 * these tests lock the exported relationships and drive real handler /
 * pairing-session implementations against them (handled vs not-handled, empty
 * vs single vs overflow collections, missing-id removal). No live HTTP server.
 */
import type http from "node:http";
import type { Media, UUID } from "@elizaos/core";
import type {
  AgentAutomationMode as SharedAgentAutomationMode,
  AgentStartupDiagnostics as SharedAgentStartupDiagnostics,
  ChatImageAttachment as SharedChatImageAttachment,
  ConversationAutomationType as SharedConversationAutomationType,
  ConversationMetadata as SharedConversationMetadata,
  ConversationScope as SharedConversationScope,
  LogEntry as SharedLogEntry,
  PluginParamDef as SharedPluginParamDef,
  SkillEntry as SharedSkillEntry,
  StreamEventEnvelope as SharedStreamEventEnvelope,
  StreamEventType as SharedStreamEventType,
  TradePermissionMode as SharedTradePermissionMode,
} from "@elizaos/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentAutomationMode,
  AgentStartupDiagnostics,
  AppManagerLike,
  ChatAttachmentWithData,
  ChatImageAttachment,
  CloudManagerLike,
  ConnectorRouteHandler,
  ConversationAutomationType,
  ConversationMeta,
  ConversationMetadata,
  ConversationScope,
  LogEntry,
  PluginEntry,
  PluginParamDef,
  ServerState,
  ShareIngestItem,
  SkillEntry,
  StoppablePairingSession,
  StreamEventEnvelope,
  StreamEventType,
  TelegramAccountAuthSessionLike,
  TradePermissionMode,
} from "./server-types.ts";
import * as serverTypes from "./server-types.ts";

const req = {} as http.IncomingMessage;
const res = {} as http.ServerResponse;
const ROOM_ID = "00000000-0000-4000-8000-000000000001" as UUID;

const PLUGIN_CATEGORIES: PluginEntry["category"][] = [
  "ai-provider",
  "connector",
  "streaming",
  "database",
  "app",
  "feature",
];

const AGENT_STATES: ServerState["agentState"][] = [
  "not_started",
  "starting",
  "running",
  "paused",
  "stopped",
  "restarting",
  "error",
];

const CAPABILITY_STATUSES: NonNullable<PluginEntry["capabilityStatus"]>[] = [
  "loaded",
  "auto-enabled",
  "blocked",
  "missing-prerequisites",
  "disabled",
];

function conversationMeta(id: string): ConversationMeta {
  return {
    id,
    title: id,
    roomId: ROOM_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function shareItem(
  id: string,
  receivedAt: number,
  extras: {
    title?: string;
    url?: string;
    text?: string;
  } = {},
): ShareIngestItem {
  return {
    id,
    source: "web",
    suggestedPrompt: `ingest ${id}`,
    receivedAt,
    ...extras,
  };
}

function pluginEntry(
  id: string,
  category: PluginEntry["category"],
  source: PluginEntry["source"],
): PluginEntry {
  return {
    id,
    name: id,
    description: `${id} plugin`,
    tags: [],
    enabled: false,
    configured: false,
    envKey: null,
    category,
    source,
    configKeys: [],
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
  };
}

function emptyState(): ServerState {
  return {
    runtime: null,
    config: {} as ServerState["config"],
    agentState: "not_started",
    agentName: "Eliza",
    model: undefined,
    startedAt: undefined,
    startup: { phase: "idle", attempt: 0 },
    plugins: [],
    skills: [],
    logBuffer: [],
    eventBuffer: [],
    nextEventId: 1,
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    adminEntityId: null,
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    cloudManager: null,
    sandboxManager: null,
    appManager: null,
    shareIngestQueue: [],
    broadcastStatus: null,
    broadcastWs: null,
    broadcastWsToClientId: null,
    broadcastWsToConversation: null,
    activeConversationId: null,
    pendingRestartReasons: [],
    connectorRouteHandlers: [],
    connectorHealthMonitor: null,
  };
}

async function dispatchConnectorRoutes(
  handlers: ConnectorRouteHandler[],
  pathname: string,
  method: string,
): Promise<boolean> {
  for (const handler of handlers) {
    const handled = await handler(req, res, pathname, method);
    if (handled) return true;
  }
  return false;
}

async function stopPairingSession(
  sessions: Map<string, StoppablePairingSession>,
  id: string,
): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  await session.stop();
  sessions.delete(id);
  return true;
}

describe("server-types", () => {
  it("is types-only: none of the exported contracts exist at runtime", () => {
    expect(Object.keys(serverTypes)).toEqual([]);
    expect("ServerState" in serverTypes).toBe(false);
    expect("PluginEntry" in serverTypes).toBe(false);
    expect("ConversationMeta" in serverTypes).toBe(false);
    expect("ShareIngestItem" in serverTypes).toBe(false);
    expect("ConnectorRouteHandler" in serverTypes).toBe(false);
    expect("StoppablePairingSession" in serverTypes).toBe(false);
    expect("TelegramAccountAuthSessionLike" in serverTypes).toBe(false);
    expect("ChatAttachmentWithData" in serverTypes).toBe(false);
    expect("CloudManagerLike" in serverTypes).toBe(false);
    expect("AppManagerLike" in serverTypes).toBe(false);
  });

  it("re-exports the shared conversation, stream, plugin, and wallet contracts", () => {
    expectTypeOf<AgentAutomationMode>().toEqualTypeOf<SharedAgentAutomationMode>();
    expectTypeOf<AgentStartupDiagnostics>().toEqualTypeOf<SharedAgentStartupDiagnostics>();
    expectTypeOf<ChatImageAttachment>().toEqualTypeOf<SharedChatImageAttachment>();
    expectTypeOf<ConversationAutomationType>().toEqualTypeOf<SharedConversationAutomationType>();
    expectTypeOf<ConversationMetadata>().toEqualTypeOf<SharedConversationMetadata>();
    expectTypeOf<ConversationScope>().toEqualTypeOf<SharedConversationScope>();
    expectTypeOf<LogEntry>().toEqualTypeOf<SharedLogEntry>();
    expectTypeOf<PluginParamDef>().toEqualTypeOf<SharedPluginParamDef>();
    expectTypeOf<SkillEntry>().toEqualTypeOf<SharedSkillEntry>();
    expectTypeOf<StreamEventEnvelope>().toEqualTypeOf<SharedStreamEventEnvelope>();
    expectTypeOf<StreamEventType>().toEqualTypeOf<SharedStreamEventType>();
    expectTypeOf<TradePermissionMode>().toEqualTypeOf<SharedTradePermissionMode>();
  });
});

describe("ConnectorRouteHandler", () => {
  it("takes the HTTP dispatch signature used by the connector plugin loop", () => {
    expectTypeOf<Parameters<ConnectorRouteHandler>>().toEqualTypeOf<
      [http.IncomingMessage, http.ServerResponse, string, string]
    >();
    expectTypeOf<ReturnType<ConnectorRouteHandler>>().toEqualTypeOf<
      Promise<boolean>
    >();
  });

  it("returns false from an empty handler queue", async () => {
    const state = emptyState();
    await expect(
      dispatchConnectorRoutes(state.connectorRouteHandlers, "/api/x", "GET"),
    ).resolves.toBe(false);
  });

  it("returns true when a single handler claims the request", async () => {
    const handler: ConnectorRouteHandler = async (
      _req,
      _res,
      pathname,
      method,
    ) => method === "GET" && pathname === "/api/x";

    await expect(handler(req, res, "/api/x", "GET")).resolves.toBe(true);
    await expect(handler(req, res, "/api/x", "POST")).resolves.toBe(false);
    await expect(handler(req, res, "/api/other", "GET")).resolves.toBe(false);
  });

  it("stops at the first handler that claims the path (later handlers are overflow)", async () => {
    const order: string[] = [];
    const first: ConnectorRouteHandler = async (_req, _res, pathname) => {
      order.push("first");
      return pathname === "/api/x";
    };
    const second: ConnectorRouteHandler = async () => {
      order.push("second");
      return true;
    };
    const state = emptyState();
    state.connectorRouteHandlers.push(first, second);

    await expect(
      dispatchConnectorRoutes(state.connectorRouteHandlers, "/api/x", "GET"),
    ).resolves.toBe(true);
    expect(order).toEqual(["first"]);

    order.length = 0;
    await expect(
      dispatchConnectorRoutes(
        state.connectorRouteHandlers,
        "/api/other",
        "GET",
      ),
    ).resolves.toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("treats two matching handlers as a first-wins tie, not dual dispatch", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first: ConnectorRouteHandler = async () => {
      firstCalls += 1;
      return true;
    };
    const second: ConnectorRouteHandler = async () => {
      secondCalls += 1;
      return true;
    };

    await expect(
      dispatchConnectorRoutes([first, second], "/api/tied", "GET"),
    ).resolves.toBe(true);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  });
});

describe("StoppablePairingSession and TelegramAccountAuthSessionLike", () => {
  it("accepts a synchronous stop", async () => {
    const stopped: string[] = [];
    const session: StoppablePairingSession = {
      stop: () => {
        stopped.push("sync");
      },
    };
    await session.stop();
    expect(stopped).toEqual(["sync"]);
  });

  it("accepts an async stop and structurally matches the telegram session", async () => {
    expectTypeOf<StoppablePairingSession>().toEqualTypeOf<TelegramAccountAuthSessionLike>();

    let released = false;
    const session: TelegramAccountAuthSessionLike = {
      stop: async () => {
        released = true;
      },
    };
    await session.stop();
    expect(released).toBe(true);
  });

  it("removing a missing pairing session is a no-op", async () => {
    const state = emptyState();
    const sessions = new Map<string, StoppablePairingSession>();
    state.whatsappPairingSessions = sessions;

    const live: StoppablePairingSession = {
      stop: () => undefined,
    };
    sessions.set("wa-1", live);

    await expect(stopPairingSession(sessions, "missing")).resolves.toBe(false);
    expect(sessions.has("wa-1")).toBe(true);

    await expect(stopPairingSession(sessions, "wa-1")).resolves.toBe(true);
    expect(sessions.size).toBe(0);

    await expect(stopPairingSession(sessions, "wa-1")).resolves.toBe(false);
  });

  it("leaves telegramAccountAuthSession null when no login flow is active", () => {
    const state = emptyState();
    expect(state.telegramAccountAuthSession).toBeUndefined();
    state.telegramAccountAuthSession = null;
    expect(state.telegramAccountAuthSession).toBeNull();
  });
});

describe("ShareIngestItem queue on ServerState", () => {
  it("starts empty and peeks as an empty array", () => {
    const state = emptyState();
    expect(state.shareIngestQueue).toEqual([]);
    expect([...state.shareIngestQueue]).toEqual([]);
  });

  it("holds a single queued item without draining on peek", () => {
    const state = emptyState();
    const item = shareItem("share-1", 10, { title: "Design doc" });
    state.shareIngestQueue.push(item);
    expect(state.shareIngestQueue).toHaveLength(1);
    expect(state.shareIngestQueue[0]).toEqual(item);
    expect(state.shareIngestQueue[0]?.title).toBe("Design doc");
  });

  it("preserves insertion order even when receivedAt ties or reverses", () => {
    const state = emptyState();
    const first = shareItem("a", 50);
    const tied = shareItem("b", 50);
    const earlierStamp = shareItem("c", 1);
    state.shareIngestQueue.push(first, tied, earlierStamp);

    expect(state.shareIngestQueue.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drains the queue by copying then clearing length (consume)", () => {
    const state = emptyState();
    state.shareIngestQueue.push(shareItem("a", 1), shareItem("b", 2));
    const items = [...state.shareIngestQueue];
    state.shareIngestQueue.length = 0;
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(state.shareIngestQueue).toEqual([]);
  });

  it("removing a missing share id leaves the queue unchanged", () => {
    const state = emptyState();
    state.shareIngestQueue.push(shareItem("keep", 1));
    const next = state.shareIngestQueue.filter((item) => item.id !== "missing");
    expect(next).toEqual(state.shareIngestQueue);
    expect(next).toHaveLength(1);
  });

  it("has no capacity cap: overflow is just a longer insertion-ordered queue", () => {
    const state = emptyState();
    for (let index = 0; index < 64; index += 1) {
      state.shareIngestQueue.push(shareItem(`share-${index}`, index));
    }
    expect(state.shareIngestQueue).toHaveLength(64);
    expect(state.shareIngestQueue[0]?.id).toBe("share-0");
    expect(state.shareIngestQueue[63]?.id).toBe("share-63");
  });
});

describe("ConversationMeta map and deletedConversationIds", () => {
  it("looks up nothing in an empty conversations map", () => {
    const state = emptyState();
    expect(state.conversations.size).toBe(0);
    expect(state.conversations.get("missing")).toBeUndefined();
    expect(state.conversations.delete("missing")).toBe(false);
  });

  it("stores a single conversation and returns undefined for a missing id", () => {
    const state = emptyState();
    const meta = conversationMeta("c-1");
    state.conversations.set(meta.id, meta);
    expect(state.conversations.get("c-1")).toEqual(meta);
    expect(state.conversations.get("c-2")).toBeUndefined();
  });

  it("tombstones deleted ids and treats a second delete of a missing id as false", () => {
    const state = emptyState();
    expect(state.deletedConversationIds.size).toBe(0);
    state.deletedConversationIds.add("c-1");
    expect(state.deletedConversationIds.has("c-1")).toBe(true);
    expect(state.deletedConversationIds.delete("c-1")).toBe(true);
    expect(state.deletedConversationIds.delete("c-1")).toBe(false);
    expect(state.deletedConversationIds.delete("never-existed")).toBe(false);
  });
});

describe("PluginEntry and ServerState unions", () => {
  it("accepts every plugin category and both sources", () => {
    const state = emptyState();
    for (const category of PLUGIN_CATEGORIES) {
      state.plugins.push(pluginEntry(`p-${category}`, category, "bundled"));
    }
    state.plugins.push(pluginEntry("store-plugin", "feature", "store"));
    expect(state.plugins).toHaveLength(PLUGIN_CATEGORIES.length + 1);
    expect(new Set(state.plugins.map((plugin) => plugin.category))).toEqual(
      new Set(PLUGIN_CATEGORIES),
    );
    expect(state.plugins.at(-1)?.source).toBe("store");
    expect(state.plugins[0]?.envKey).toBeNull();
  });

  it("records each capabilityStatus without inventing a loaded plugin", () => {
    const statuses: Array<PluginEntry["capabilityStatus"]> = [];
    for (const capabilityStatus of CAPABILITY_STATUSES) {
      const entry = pluginEntry(capabilityStatus, "feature", "bundled");
      entry.capabilityStatus = capabilityStatus;
      statuses.push(entry.capabilityStatus);
    }
    expect(statuses).toEqual(CAPABILITY_STATUSES);
  });

  it("accepts every agentState discriminant on a constructed ServerState", () => {
    const seen: ServerState["agentState"][] = [];
    for (const agentState of AGENT_STATES) {
      const state = emptyState();
      state.agentState = agentState;
      seen.push(state.agentState);
    }
    expect(seen).toEqual(AGENT_STATES);
  });

  it("treats CloudManagerLike null and AppManagerLike unknown as first-run values", () => {
    const cloud: CloudManagerLike = null;
    const app: AppManagerLike = { launched: false };
    const state = emptyState();
    expect(cloud).toBeNull();
    expect(state.cloudManager).toBeNull();
    state.appManager = app;
    expect(state.appManager).toEqual({ launched: false });
  });

  it("starts pendingRestartReasons empty and accumulates overflow reasons in order", () => {
    const state = emptyState();
    expect(state.pendingRestartReasons).toEqual([]);
    state.pendingRestartReasons.push("plugin-reload", "config-change");
    expect(state.pendingRestartReasons).toEqual([
      "plugin-reload",
      "config-change",
    ]);
  });
});

describe("ChatAttachmentWithData", () => {
  it("extends Media with in-memory _data and _mimeType that Media itself does not require", () => {
    expectTypeOf<ChatAttachmentWithData>().toMatchTypeOf<Media>();
    expectTypeOf<Media>().not.toMatchTypeOf<ChatAttachmentWithData>();
    expectTypeOf<ChatAttachmentWithData["_data"]>().toEqualTypeOf<string>();
    expectTypeOf<ChatAttachmentWithData["_mimeType"]>().toEqualTypeOf<string>();

    const attachment: ChatAttachmentWithData = {
      id: "att-1",
      url: "https://example.invalid/a.png",
      _data: "aGVsbG8=",
      _mimeType: "image/png",
    };
    expect(attachment._data).toBe("aGVsbG8=");
    expect(attachment._mimeType).toBe("image/png");
    expect(attachment.id).toBe("att-1");
  });
});

describe("ServerState broadcast hooks", () => {
  it("starts with null broadcast hooks so first-run cannot emit", () => {
    const state = emptyState();
    expect(state.broadcastStatus).toBeNull();
    expect(state.broadcastWs).toBeNull();
    expect(state.broadcastWsToClientId).toBeNull();
    expect(state.broadcastWsToConversation).toBeNull();
    expect(state.activeConversationId).toBeNull();
  });

  it("returns 0 from a conversation broadcast when no clients are bound", () => {
    const state = emptyState();
    const delivered: Array<{ conversationId: string; data: object }> = [];
    state.broadcastWsToConversation = (conversationId, data) => {
      delivered.push({ conversationId, data });
      return 0;
    };
    expect(state.broadcastWsToConversation("c-missing", { type: "ping" })).toBe(
      0,
    );
    expect(delivered).toEqual([
      { conversationId: "c-missing", data: { type: "ping" } },
    ]);
  });

  it("returns 0 from a client-id broadcast when the id is missing", () => {
    const state = emptyState();
    state.broadcastWsToClientId = (clientId, _data) =>
      clientId === "live" ? 1 : 0;
    expect(state.broadcastWsToClientId("missing", { type: "ping" })).toBe(0);
    expect(state.broadcastWsToClientId("live", { type: "ping" })).toBe(1);
  });
});
