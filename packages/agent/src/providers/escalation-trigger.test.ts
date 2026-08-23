/**
 * Behavioral coverage for the escalation-trigger provider: empty output,
 * admin vs non-admin check routing, active-escalation formatting, owner
 * inactivity (autonomous-loop gate, 24h threshold, timestamp ordering),
 * pending identity verifications, and highest-urgency reduction.
 * The provider is real; only collaborators (admin gate, EscalationService
 * lookup, runtime memory/relationship reads) are stubbed.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EscalationState } from "../services/escalation.ts";
import { EscalationService } from "../services/escalation.ts";

vi.mock("../security/access.ts", () => ({
  hasAdminAccess: vi.fn(),
}));

import { hasAdminAccess } from "../security/access.ts";
import {
  createEscalationTriggerProvider,
  escalationTriggerProvider,
} from "./escalation-trigger.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const USER_ID = "00000000-0000-4000-8000-0000000000cc" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000dd" as UUID;
const MESSAGE_ID = "00000000-0000-4000-8000-0000000000ee" as UUID;
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };
const NOW = 1_700_000_000_000;
const HOUR_MS = 1000 * 60 * 60;

type MemoryRow = {
  entityId: string;
  createdAt?: number | null;
};

type RelationshipRow = {
  metadata?: Record<string, unknown>;
};

type RuntimeOpts = {
  agentId?: UUID;
  ownerId?: string | null;
  rooms?: UUID[];
  memories?: MemoryRow[];
  relationships?: RelationshipRow[];
  relationshipsError?: Error;
};

function makeMessage(entityId: UUID): Memory {
  return {
    id: MESSAGE_ID,
    entityId,
    roomId: ROOM_ID,
    agentId: AGENT_ID,
    content: { text: "ping" },
  } as Memory;
}

function makeRuntime(opts: RuntimeOpts = {}): IAgentRuntime {
  const agentId = opts.agentId ?? AGENT_ID;
  const ownerId = opts.ownerId === undefined ? OWNER_ID : opts.ownerId;
  return {
    agentId,
    character: { name: "test-agent" },
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? (ownerId ?? undefined) : undefined,
    getRoomsForParticipant: async () => opts.rooms ?? [],
    getMemoriesByRoomIds: async () => (opts.memories ?? []) as Memory[],
    getRelationships: async () => {
      if (opts.relationshipsError) {
        throw opts.relationshipsError;
      }
      return opts.relationships ?? [];
    },
    getWorld: async () => null,
    getRoom: async () => null,
    getService: () => null,
    getEntityById: async () => null,
    setCache: async () => true,
    getCache: async () => null,
    deleteCache: async () => true,
    sendMessageToTarget: async () => {},
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function activeState(
  overrides: {
    reason?: string;
    currentStep?: number;
    channelsSent?: string[];
    resolved?: boolean;
  } = {},
): EscalationState {
  return {
    id: "esc-1",
    reason: overrides.reason ?? "disk full",
    text: "please look",
    currentStep: overrides.currentStep ?? 1,
    channelsSent: overrides.channelsSent ?? ["client_chat", "telegram"],
    startedAt: NOW,
    lastSentAt: NOW,
    resolved: overrides.resolved ?? false,
  };
}

async function getProvider(runtime: IAgentRuntime, entityId: UUID = USER_ID) {
  return createEscalationTriggerProvider().get(
    runtime,
    makeMessage(entityId),
    EMPTY_STATE,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(hasAdminAccess).mockResolvedValue(true);
});

afterEach(() => {
  EscalationService._reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("escalationTriggerProvider metadata", () => {
  it("exports a dynamic general-context provider at position 15", () => {
    expect(escalationTriggerProvider.name).toBe("escalationTrigger");
    expect(escalationTriggerProvider.dynamic).toBe(true);
    expect(escalationTriggerProvider.position).toBe(15);
    expect(escalationTriggerProvider.contexts).toEqual(["general"]);
    expect(escalationTriggerProvider.contextGate).toEqual({
      anyOf: ["general"],
    });
    expect(escalationTriggerProvider.cacheStable).toBe(false);
    expect(escalationTriggerProvider.cacheScope).toBe("turn");
    expect(escalationTriggerProvider.roleGate).toEqual({ minRole: "USER" });
    expect(escalationTriggerProvider.description).toContain("escalat");
  });

  it("createEscalationTriggerProvider returns a fresh provider with the same contract", () => {
    const created = createEscalationTriggerProvider();
    expect(created).not.toBe(escalationTriggerProvider);
    expect(created.name).toBe("escalationTrigger");
    expect(typeof created.get).toBe("function");
  });
});

describe("empty trigger set", () => {
  it("returns the empty result when an admin viewer has nothing pending", async () => {
    const result = await getProvider(makeRuntime());
    expect(result).toEqual({
      text: "",
      values: { hasEscalationTriggers: false },
      data: {},
    });
  });

  it("returns empty when a non-admin viewer has no pending verifications", async () => {
    vi.mocked(hasAdminAccess).mockResolvedValue(false);
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      activeState(),
    );

    const result = await getProvider(makeRuntime());
    expect(result.values?.hasEscalationTriggers).toBe(false);
    expect(result.text).toBe("");
    expect(result.data).toEqual({});
  });
});

describe("active escalation", () => {
  it("formats an unresolved escalation as a high-urgency trigger", async () => {
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      activeState({
        currentStep: 1,
        channelsSent: ["client_chat", "telegram"],
      }),
    );

    const result = await getProvider(makeRuntime());
    expect(result.values).toEqual({
      hasEscalationTriggers: true,
      triggerCount: 1,
      highestUrgency: "high",
    });
    expect(result.text).toBe(
      [
        "# Escalation Context",
        '- [HIGH] Active escalation in progress (step 2): "disk full". Channels notified: client_chat, telegram. Owner has not responded yet.',
      ].join("\n"),
    );
    expect(result.data).toEqual({
      triggers: [
        {
          type: "active_escalation",
          urgency: "high",
          message:
            'Active escalation in progress (step 2): "disk full". Channels notified: client_chat, telegram. Owner has not responded yet.',
        },
      ],
    });
  });

  it("omits a resolved escalation even if the lookup still returns it", async () => {
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      activeState({ resolved: true }),
    );

    const result = await getProvider(makeRuntime());
    expect(result.values?.hasEscalationTriggers).toBe(false);
    expect(result.text).toBe("");
  });

  it("omits the trigger when getActiveEscalationSync returns null", async () => {
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      null,
    );

    const result = await getProvider(makeRuntime());
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });

  it("degrades to empty when the active-escalation lookup throws", async () => {
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockImplementation(
      () => {
        throw new Error("escalation map unavailable");
      },
    );

    const result = await getProvider(makeRuntime());
    expect(result.values?.hasEscalationTriggers).toBe(false);
    expect(result.text).toBe("");
  });

  it("renders an empty channels list when none have been notified yet", async () => {
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      activeState({ currentStep: 0, channelsSent: [] }),
    );

    const result = await getProvider(makeRuntime());
    expect(result.text).toContain(
      'Active escalation in progress (step 1): "disk full". Channels notified: . Owner has not responded yet.',
    );
  });

  it("reads a live EscalationService row started on the same runtime", async () => {
    const runtime = makeRuntime();
    const started = await EscalationService.startEscalation(
      runtime,
      "owner unreachable",
      "please check in",
    );

    const result = await getProvider(runtime);
    expect(result.values?.hasEscalationTriggers).toBe(true);
    expect(result.values?.highestUrgency).toBe("high");
    expect(result.text).toContain(`"${started.reason}"`);
    expect(result.text).toContain(`step ${started.currentStep + 1}`);
  });
});

describe("owner inactivity", () => {
  it("skips inactivity when the message is not from the agent itself", async () => {
    const lastSeen = NOW - 48 * HOUR_MS;
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: lastSeen }],
      }),
      USER_ID,
    );
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });

  it("emits a low-urgency check-in when the owner has been silent for more than 24h during an autonomous loop", async () => {
    const lastSeen = NOW - 25 * HOUR_MS;
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: lastSeen }],
      }),
      AGENT_ID,
    );
    expect(result.values).toEqual({
      hasEscalationTriggers: true,
      triggerCount: 1,
      highestUrgency: "low",
    });
    expect(result.text).toContain(
      "- [LOW] Owner last seen 25 hours ago. Consider checking in if there are pending items.",
    );
  });

  it("does not trigger at exactly 24 hours (threshold is exclusive)", async () => {
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: NOW - 24 * HOUR_MS }],
      }),
      AGENT_ID,
    );
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });

  it("does not trigger below 24 hours", async () => {
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: NOW - 23 * HOUR_MS }],
      }),
      AGENT_ID,
    );
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });

  it("returns empty when the owner has no rooms (no last-seen timestamp)", async () => {
    const result = await getProvider(makeRuntime({ rooms: [] }), AGENT_ID);
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });

  it("ignores memories from other entities and null createdAt when finding the latest owner message", async () => {
    const ownerLatest = NOW - 40 * HOUR_MS;
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [
          { entityId: USER_ID, createdAt: NOW - 2 * HOUR_MS },
          { entityId: OWNER_ID, createdAt: null },
          { entityId: OWNER_ID, createdAt: ownerLatest },
          { entityId: OWNER_ID, createdAt: NOW - 80 * HOUR_MS },
        ],
      }),
      AGENT_ID,
    );
    expect(result.text).toContain("Owner last seen 40 hours ago");
  });

  it("keeps the first timestamp on an equal-createdAt tie", async () => {
    const tied = NOW - 30 * HOUR_MS;
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [
          { entityId: OWNER_ID, createdAt: tied },
          { entityId: OWNER_ID, createdAt: tied },
        ],
      }),
      AGENT_ID,
    );
    expect(result.text).toContain("Owner last seen 30 hours ago");
  });

  it("skips inactivity when no owner entity can be resolved", async () => {
    const result = await getProvider(
      makeRuntime({
        ownerId: null,
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: NOW - 48 * HOUR_MS }],
      }),
      AGENT_ID,
    );
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });

  it("skips inactivity when owner rooms exist but none of the memories belong to the owner", async () => {
    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: USER_ID, createdAt: NOW - 48 * HOUR_MS }],
      }),
      AGENT_ID,
    );
    expect(result.values?.hasEscalationTriggers).toBe(false);
  });
});

describe("pending identity verifications", () => {
  it("counts proposed identity_link rows as a medium-urgency trigger", async () => {
    const result = await getProvider(
      makeRuntime({
        relationships: [
          { metadata: { status: "proposed" } },
          { metadata: { status: "proposed" } },
          { metadata: { status: "confirmed" } },
          { metadata: {} },
          {},
        ],
      }),
    );
    expect(result.values).toEqual({
      hasEscalationTriggers: true,
      triggerCount: 1,
      highestUrgency: "medium",
    });
    expect(result.text).toContain(
      "- [MEDIUM] 2 identity verification(s) pending for the current user. You can ask them to confirm or have an admin verify.",
    );
  });

  it("treats a single proposed verification as count 1", async () => {
    const result = await getProvider(
      makeRuntime({
        relationships: [{ metadata: { status: "proposed" } }],
      }),
    );
    expect(result.text).toContain("1 identity verification(s) pending");
    expect(result.values?.triggerCount).toBe(1);
  });

  it("silently skips when getRelationships throws", async () => {
    const result = await getProvider(
      makeRuntime({
        relationshipsError: new Error("relationship store down"),
      }),
    );
    expect(result.values?.hasEscalationTriggers).toBe(false);
    expect(result.text).toBe("");
  });

  it("still surfaces pending verifications to a non-admin viewer", async () => {
    vi.mocked(hasAdminAccess).mockResolvedValue(false);
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      activeState(),
    );

    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: NOW - 48 * HOUR_MS }],
        relationships: [{ metadata: { status: "proposed" } }],
      }),
      AGENT_ID,
    );

    expect(result.values).toEqual({
      hasEscalationTriggers: true,
      triggerCount: 1,
      highestUrgency: "medium",
    });
    expect(result.text).toContain("1 identity verification(s) pending");
    expect(result.text).not.toContain("Active escalation");
    expect(result.text).not.toContain("Owner last seen");
  });
});

describe("urgency reduction and combined output", () => {
  it("ranks high above medium and low when all three checks fire", async () => {
    vi.spyOn(EscalationService, "getActiveEscalationSync").mockReturnValue(
      activeState(),
    );

    const result = await getProvider(
      makeRuntime({
        rooms: [ROOM_ID],
        memories: [{ entityId: OWNER_ID, createdAt: NOW - 30 * HOUR_MS }],
        relationships: [{ metadata: { status: "proposed" } }],
      }),
      AGENT_ID,
    );

    expect(result.values).toEqual({
      hasEscalationTriggers: true,
      triggerCount: 3,
      highestUrgency: "high",
    });
    expect(result.text?.startsWith("# Escalation Context\n")).toBe(true);
    expect(result.text).toContain("[HIGH]");
    expect(result.text).toContain("[MEDIUM]");
    expect(result.text).toContain("[LOW]");
  });

  it("keeps medium as the highest when only pending verifications fire", async () => {
    const result = await getProvider(
      makeRuntime({
        relationships: [{ metadata: { status: "proposed" } }],
      }),
    );
    expect(result.values?.highestUrgency).toBe("medium");
    expect(result.values?.triggerCount).toBe(1);
  });
});
