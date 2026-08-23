/**
 * MEMORY op:search enumeration lane: "what have we talked about lately" is a
 * time-slice request, not a keyword lookup, so doSearch leads with a
 * chronological cross-room digest — but ONLY when the live delivery audience
 * is a verified owner-private destination (owner DM / voice_private /
 * api_private with a 2-member {owner, agent} census; every group/channel kind
 * is denied).
 *
 * The digest's output contract is completeness-first and these tests are its
 * adversarial proof:
 * - complete traversal via advancing store pages: inputs beyond every former
 *   cap (>15 rooms, >800 rows, lines >220 chars) render with NO data dropped;
 * - explicit caller-selected paging: pages partition the digest exactly, and
 *   the footer names the continuation;
 * - dedupe removes only the double-persist twin: same-prefix DISTINCT rows
 *   both render;
 * - unstable stores (stalled or changing pages) and injected read/gate
 *   failures produce a TYPED unavailable outcome through reportError — never
 *   a healthy-looking keyword result and never a partial digest;
 * - the endorsed security gate carries forward: AccessContext reaches the
 *   store read, cross-room scoping excludes rooms the sender is not in, the
 *   egress mark is set on render (not on deny), and suppression is recorded
 *   only on a real deny (not on the wrong-basis internal_agent_turn case).
 *
 * Deterministic: @elizaos/core is partially mocked to drive the disclosure
 * verdict and observe the mark/suppression calls; the runtime is an in-memory
 * fake whose getMemoriesByRoomIds honors the store's createdAt-DESC
 * limit/offset contract.
 */
import type {
  AccessContext,
  ActionResult,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateOwnerExclusiveDisclosure = vi.fn();
const markOwnerExclusiveDisclosureUsed = vi.fn();
const recordOwnerExclusiveSuppression = vi.fn();
const buildAccessContext = vi.fn();
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    revalidateOwnerExclusiveDisclosure: (
      ...args: Parameters<typeof actual.revalidateOwnerExclusiveDisclosure>
    ) => revalidateOwnerExclusiveDisclosure(...args),
    markOwnerExclusiveDisclosureUsed: (
      ...args: Parameters<typeof actual.markOwnerExclusiveDisclosureUsed>
    ) => markOwnerExclusiveDisclosureUsed(...args),
    recordOwnerExclusiveSuppression: (
      ...args: Parameters<typeof actual.recordOwnerExclusiveSuppression>
    ) => recordOwnerExclusiveSuppression(...args),
    buildAccessContext: (
      ...args: Parameters<typeof actual.buildAccessContext>
    ) => buildAccessContext(...args),
  };
});

// Imported after the mock so the action binds the mocked seams.
const { memoryAction } = await import("./memories");
const { OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS } = await import(
  "@elizaos/core"
);

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const STRANGER_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;
const DM_ROOM = "00000000-0000-0000-0000-0000000000c1" as UUID;
const OTHER_ROOM = "00000000-0000-0000-0000-0000000000c2" as UUID;
const FOREIGN_ROOM = "00000000-0000-0000-0000-0000000000c3" as UUID;

const HOUR = 60 * 60 * 1000;
const ACCESS_CONTEXT_SENTINEL = {
  requesterEntityId: OWNER_ID,
  isOwner: true,
} as AccessContext;

type SeedMessage = {
  id?: UUID;
  roomId: UUID;
  entityId: UUID;
  text: string;
  createdAt: number;
  platformMessageId?: string;
};

interface FakeRuntimeOptions {
  /** Rooms per participant entity. Default: every seeded room, for OWNER. */
  roomsByEntity?: Map<UUID, UUID[]>;
  /** Replace the paged store read wholesale (failure/instability injection). */
  getMemoriesByRoomIds?: (params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
    offset?: number;
    accessContext?: AccessContext;
  }) => Promise<Memory[]>;
}

interface FakeRuntime {
  runtime: IAgentRuntime;
  reportError: ReturnType<typeof vi.fn>;
  roomIdsSeenByStore: () => Set<UUID>;
  accessContextsSeenByStore: () => (AccessContext | undefined)[];
}

function seedToMemory(row: SeedMessage): Memory {
  return {
    id: (row.id ?? (crypto.randomUUID() as UUID)) as UUID,
    entityId: row.entityId,
    agentId: AGENT_ID,
    roomId: row.roomId,
    content: { text: row.text },
    metadata: row.platformMessageId
      ? { platformMessageId: row.platformMessageId }
      : undefined,
    createdAt: row.createdAt,
  } as Memory;
}

function makeRuntime(
  seed: SeedMessage[],
  options: FakeRuntimeOptions = {},
): FakeRuntime {
  const messages = seed.map(seedToMemory);
  const reportError = vi.fn();
  const storeRoomIds = new Set<UUID>();
  const storeAccessContexts: (AccessContext | undefined)[] = [];

  const pagedRead = async (params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
    offset?: number;
    accessContext?: AccessContext;
  }): Promise<Memory[]> => {
    // Store contract: createdAt DESC, LIMIT/OFFSET over the scoped set.
    const inScope = messages
      .filter((m) => params.roomIds.includes(m.roomId))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const offset = params.offset ?? 0;
    const sliced = inScope.slice(offset);
    return params.limit == null ? sliced : sliced.slice(0, params.limit);
  };

  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: () => undefined,
    // No relationships service: getRelatedEntityIds degrades to [entityId].
    getService: () => null,
    reportError,
    getRoomsForParticipant: async (entityId: UUID) => {
      if (options.roomsByEntity) {
        return options.roomsByEntity.get(entityId) ?? [];
      }
      return [...new Set(messages.map((m) => m.roomId))];
    },
    getMemoriesByRoomIds: async (params: {
      tableName: string;
      roomIds: UUID[];
      limit?: number;
      offset?: number;
      accessContext?: AccessContext;
    }) => {
      for (const id of params.roomIds) storeRoomIds.add(id);
      storeAccessContexts.push(params.accessContext);
      const read = options.getMemoriesByRoomIds ?? pagedRead;
      return read(params);
    },
    // The keyword scan's windowed per-table read. Only the messages table has
    // rows here; other tables are empty.
    getMemories: async (params: {
      tableName: string;
      roomId?: UUID;
      limit?: number;
    }) => {
      if (params.tableName !== "messages") return [];
      const inScope = messages.filter(
        (m) => !params.roomId || m.roomId === params.roomId,
      );
      const limited =
        params.limit == null ? inScope : inScope.slice(-params.limit);
      return [...limited].reverse();
    },
  } as unknown as IAgentRuntime;

  return {
    runtime,
    reportError,
    roomIdsSeenByStore: () => storeRoomIds,
    accessContextsSeenByStore: () => storeAccessContexts,
  };
}

function makeMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: DM_ROOM,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

async function runSearch(
  runtime: IAgentRuntime,
  message: Memory,
  query: string,
  page?: number,
): Promise<ActionResult> {
  const result = await memoryAction.handler(runtime, message, undefined, {
    parameters: { action: "search", query, ...(page ? { page } : {}) },
  });
  if (!result) throw new Error("handler returned no result");
  return result;
}

function allowOwnerPrivate(): void {
  revalidateOwnerExclusiveDisclosure.mockResolvedValue({
    allowed: true,
    basis: OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
    audience: {},
  });
}

function denyMixedRoom(): void {
  revalidateOwnerExclusiveDisclosure.mockResolvedValue({
    allowed: false,
    reason: "destination_not_private",
    audience: {},
  });
}

function recentSeed(): SeedMessage[] {
  const now = Date.now();
  return [
    {
      roomId: DM_ROOM,
      entityId: OWNER_ID,
      text: "the dmarz entropy talk on the roof went late",
      createdAt: now - 30 * HOUR,
    },
    {
      roomId: OTHER_ROOM,
      entityId: OWNER_ID,
      text: "ordered the alexis supplements finally",
      createdAt: now - 20 * HOUR,
    },
    {
      roomId: DM_ROOM,
      entityId: AGENT_ID,
      text: "logged the covenant follow-ups for tomorrow",
      createdAt: now - 10 * HOUR,
    },
  ];
}

beforeEach(() => {
  revalidateOwnerExclusiveDisclosure.mockReset();
  markOwnerExclusiveDisclosureUsed.mockReset();
  recordOwnerExclusiveSuppression.mockReset();
  buildAccessContext.mockReset();
  buildAccessContext.mockResolvedValue(ACCESS_CONTEXT_SENTINEL);
});

describe("owner-private destination (gate open)", () => {
  it("leads with a chronological cross-room digest for a time-slice query", async () => {
    allowOwnerPrivate();
    const { runtime } = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.success).toBe(true);
    expect(result.values?.historyDigestIncluded).toBe(true);
    const text = result.text ?? "";
    expect(text).toContain("owner-private destination verified");
    // Cross-room: rows from BOTH rooms render.
    expect(text).toContain("dmarz entropy talk");
    expect(text).toContain("alexis supplements");
    expect(text).toContain("covenant follow-ups");
    // Chronological: oldest first, across rooms.
    const first = text.indexOf("dmarz entropy talk");
    const second = text.indexOf("alexis supplements");
    const third = text.indexOf("covenant follow-ups");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    // Speaker labels: the agent's own rows carry the character name.
    expect(text).toContain("Eliza: logged the covenant follow-ups");
  });

  it("marks owner-exclusive disclosure as used when the digest renders", async () => {
    allowOwnerPrivate();
    const { runtime } = makeRuntime(recentSeed());
    const message = makeMessage("what have we talked about lately");
    await runSearch(runtime, message, "what have we talked about lately");

    expect(markOwnerExclusiveDisclosureUsed).toHaveBeenCalledWith(message);
    expect(recordOwnerExclusiveSuppression).not.toHaveBeenCalled();
  });

  it("passes the built AccessContext to every store read", async () => {
    allowOwnerPrivate();
    const fake = makeRuntime(recentSeed());
    const message = makeMessage("catch me up");
    await runSearch(fake.runtime, message, "catch me up");

    expect(buildAccessContext).toHaveBeenCalledWith(fake.runtime, message);
    const contexts = fake.accessContextsSeenByStore();
    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) {
      expect(ctx).toBe(ACCESS_CONTEXT_SENTINEL);
    }
  });

  it("drops rows older than the digest window", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const { runtime } = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "ancient message from three weeks ago",
        createdAt: now - 21 * 24 * HOUR,
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "fresh message from yesterday",
        createdAt: now - 20 * HOUR,
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("what did we discuss the last few days"),
      "what did we discuss the last few days",
    );

    // The keyword lane below the digest may still match the old row; the
    // WINDOW claim is about the digest section only, so scope the assertion.
    const text = result.text ?? "";
    const digestSection = text.slice(0, text.indexOf("Showing"));
    expect(digestSection).toContain("fresh message from yesterday");
    expect(digestSection).not.toContain("ancient message");
  });
});

describe("completeness beyond every former cap", () => {
  it("renders every row across >15 rooms with no room dropped", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const roomCount = 20; // former cap: 15 rooms
    const seed: SeedMessage[] = [];
    for (let i = 0; i < roomCount; i += 1) {
      seed.push({
        roomId:
          `00000000-0000-0000-0000-${String(1000 + i).padStart(12, "0")}` as UUID,
        entityId: OWNER_ID,
        text: `unique marker for room number ${i} zqx${i}zqx`,
        createdAt: now - (roomCount - i) * HOUR,
      });
    }
    const { runtime } = makeRuntime(seed);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.success).toBe(true);
    const text = result.text ?? "";
    for (let i = 0; i < roomCount; i += 1) {
      expect(text).toContain(`zqx${i}zqx`);
    }
    expect(result.values?.historyDigestRoomCount).toBe(roomCount);
  });

  it("traverses >800 rows completely and partitions them exactly across explicit pages", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const rowCount = 1200; // former cap: 800 fetched rows, 80 rendered lines
    const seed: SeedMessage[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      seed.push({
        roomId: i % 2 === 0 ? DM_ROOM : OTHER_ROOM,
        entityId: OWNER_ID,
        text: `row marker qq${i}qq end`,
        createdAt: now - 6 * 24 * HOUR + i * 60_000,
      });
    }
    const { runtime } = makeRuntime(seed);

    const firstPage = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );
    expect(firstPage.success).toBe(true);
    expect(firstPage.values?.historyDigestTotalLines).toBe(rowCount);
    const pageCount = firstPage.values?.historyDigestPageCount as number;
    expect(pageCount).toBeGreaterThan(1);
    expect(firstPage.text ?? "").toContain(`page:2 to continue`);

    // Union of all caller-selected pages = every row exactly once.
    const seen = new Map<number, number>();
    for (let page = 1; page <= pageCount; page += 1) {
      const result = await runSearch(
        runtime,
        makeMessage("catch me up"),
        "catch me up",
        page,
      );
      expect(result.success).toBe(true);
      expect(result.values?.historyDigestPage).toBe(page);
      const digestText = (result.text ?? "").slice(
        0,
        (result.text ?? "").indexOf("Showing"),
      );
      for (const match of digestText.matchAll(/qq(\d+)qq/g)) {
        const idx = Number(match[1]);
        seen.set(idx, (seen.get(idx) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(rowCount);
    for (const [, count] of seen) expect(count).toBe(1);
  });

  it("renders lines longer than 220 chars with COMPLETE text, no truncation", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const longTail = "TAIL_MARKER_AT_THE_VERY_END_OF_THE_LONG_LINE";
    const longText = `${"the quick brown fox jumps over the lazy dog ".repeat(12)}${longTail}`;
    expect(longText.length).toBeGreaterThan(400); // well past the former 220 cap
    const { runtime } = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: longText,
        createdAt: now - 5 * HOUR,
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.text ?? "").toContain(longTail);
  });

  it("clamps an out-of-range requested page instead of dropping data", async () => {
    allowOwnerPrivate();
    const { runtime } = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
      99,
    );
    expect(result.success).toBe(true);
    expect(result.values?.historyDigestPage).toBe(1);
    expect(result.text ?? "").toContain("Requested page 99");
    expect(result.text ?? "").toContain("dmarz entropy talk");
  });
});

describe("dedupe: twins collapse, distinct rows never do", () => {
  it("renders same-prefix DISTINCT rows (shared 120+ char prefix, different tails) BOTH", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const sharedPrefix =
      "we walked through the deployment plan for the new gateway cluster and agreed the rollout should start with the canary region before ";
    expect(sharedPrefix.length).toBeGreaterThan(120);
    const { runtime } = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: `${sharedPrefix}FIRST_DISTINCT_TAIL`,
        createdAt: now - 6 * HOUR,
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: `${sharedPrefix}SECOND_DISTINCT_TAIL`,
        createdAt: now - 6 * HOUR + 250, // inside the twin timing window
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    const text = result.text ?? "";
    expect(text).toContain("FIRST_DISTINCT_TAIL");
    expect(text).toContain("SECOND_DISTINCT_TAIL");
  });

  it("renders double-persisted twin rows (identical text ~250ms apart) once", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const { runtime } = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "twin persisted line about the roof",
        createdAt: now - 6 * HOUR,
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "twin persisted line about the roof",
        createdAt: now - 6 * HOUR + 250,
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    const digestText = (result.text ?? "").slice(
      0,
      (result.text ?? "").indexOf("Showing"),
    );
    const occurrences =
      digestText.split("twin persisted line about the roof").length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders twin rows sharing a platformMessageId once", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const { runtime } = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "platform twin body",
        createdAt: now - 6 * HOUR,
        platformMessageId: "discord-123",
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "platform twin body",
        createdAt: now - 6 * HOUR + 250,
        platformMessageId: "discord-123",
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    const digestText = (result.text ?? "").slice(
      0,
      (result.text ?? "").indexOf("Showing"),
    );
    expect(digestText.split("platform twin body").length - 1).toBe(1);
  });

  it("renders a GENUINE repeat (identical text minutes apart) twice", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const { runtime } = makeRuntime([
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "are you there",
        createdAt: now - 6 * HOUR,
      },
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "are you there",
        createdAt: now - 6 * HOUR + 10 * 60_000,
      },
    ]);
    const result = await runSearch(
      runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    const digestText = (result.text ?? "").slice(
      0,
      (result.text ?? "").indexOf("Showing"),
    );
    expect(digestText.split("are you there").length - 1).toBe(2);
  });
});

describe("unstable stores return typed-incomplete, never a partial", () => {
  it("detects a stalled (non-advancing) page and reports it", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const stuckPage: SeedMessage[] = [];
    for (let i = 0; i < 500; i += 1) {
      stuckPage.push({
        id: `00000000-0000-0000-0000-${String(2000 + i).padStart(12, "0")}` as UUID,
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: `stalled row ${i}`,
        createdAt: now - i * 1000,
      });
    }
    const stuckMemories = stuckPage.map(seedToMemory);
    const fake = makeRuntime(recentSeed(), {
      // Ignores offset: every read returns the identical full page.
      getMemoriesByRoomIds: async () => stuckMemories,
    });
    const result = await runSearch(
      fake.runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MEMORY_HISTORY_DIGEST_INCOMPLETE");
    expect(result.text ?? "").toContain("No partial digest was emitted");
    expect(result.text ?? "").not.toContain("stalled row");
    expect(fake.reportError).toHaveBeenCalledWith(
      "MemoryAction.recentHistoryDigest.traversal",
      expect.any(Error),
      expect.objectContaining({ offset: expect.any(Number) }),
    );
  });

  it("detects pages that change (newer rows appearing mid-traversal) and reports it", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const makePage = (startId: number, newest: number): Memory[] => {
      const rows: SeedMessage[] = [];
      for (let i = 0; i < 500; i += 1) {
        rows.push({
          id: `00000000-0000-0000-0000-${String(startId + i).padStart(12, "0")}` as UUID,
          roomId: DM_ROOM,
          entityId: OWNER_ID,
          text: `shifting row ${startId + i}`,
          createdAt: newest - i * 1000,
        });
      }
      return rows.map(seedToMemory);
    };
    let call = 0;
    const fake = makeRuntime(recentSeed(), {
      getMemoriesByRoomIds: async () => {
        call += 1;
        // Page 2 is NEWER than page 1's oldest boundary: the set shifted.
        return call === 1
          ? makePage(300000, now - HOUR)
          : makePage(400000, now);
      },
    });
    const result = await runSearch(
      fake.runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MEMORY_HISTORY_DIGEST_INCOMPLETE");
    expect(result.text ?? "").not.toContain("shifting row");
    expect(fake.reportError).toHaveBeenCalledWith(
      "MemoryAction.recentHistoryDigest.traversal",
      expect.any(Error),
      expect.anything(),
    );
  });

  it("stops an interval wider than the traversal budget with typed-incomplete", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    let nextId = 500000;
    const fake = makeRuntime(recentSeed(), {
      // Endless well-formed pages: always full, always advancing, always
      // inside the window. Budget must end this, not a silent partial.
      getMemoriesByRoomIds: async (params) => {
        const offset = params.offset ?? 0;
        const rows: SeedMessage[] = [];
        for (let i = 0; i < 500; i += 1) {
          nextId += 1;
          rows.push({
            id: `00000000-0000-0000-0000-${String(nextId).padStart(12, "0")}` as UUID,
            roomId: DM_ROOM,
            entityId: OWNER_ID,
            text: `endless row ${offset + i}`,
            createdAt: now - offset - i, // ms apart, never crosses the cutoff
          });
        }
        return rows.map(seedToMemory);
      },
    });
    const result = await runSearch(
      fake.runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MEMORY_HISTORY_DIGEST_INCOMPLETE");
    expect(result.text ?? "").not.toContain("endless row");
  });
});

describe("injected failures surface as typed unavailable through reportError", () => {
  it("READ failure: getMemoriesByRoomIds throws -> reportError + typed unavailable, no keyword disguise", async () => {
    allowOwnerPrivate();
    const fake = makeRuntime(recentSeed(), {
      getMemoriesByRoomIds: async () => {
        throw new Error("connection reset by peer");
      },
    });
    const result = await runSearch(
      fake.runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MEMORY_HISTORY_DIGEST_UNAVAILABLE");
    expect(fake.reportError).toHaveBeenCalledWith(
      "MemoryAction.recentHistoryDigest.read",
      expect.any(Error),
      expect.anything(),
    );
    // NOT a healthy keyword result: no match listing, no scan-window prose.
    expect(result.text ?? "").not.toContain("match(es)");
    expect(result.text ?? "").not.toContain("Scanned only");
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
  });

  it("GATE failure: revalidate throws -> reportError + typed unavailable, no keyword disguise", async () => {
    revalidateOwnerExclusiveDisclosure.mockRejectedValue(
      new Error("audience lookup timed out"),
    );
    const fake = makeRuntime(recentSeed());
    const result = await runSearch(
      fake.runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MEMORY_HISTORY_DIGEST_UNAVAILABLE");
    expect(fake.reportError).toHaveBeenCalledWith(
      "MemoryAction.recentHistoryDigest.gate",
      expect.any(Error),
      expect.anything(),
    );
    expect(result.text ?? "").not.toContain("match(es)");
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
  });

  it("scope failure: getRoomsForParticipant throws -> reportError + typed unavailable", async () => {
    allowOwnerPrivate();
    const seed = recentSeed();
    const fake = makeRuntime(seed);
    (
      fake.runtime as unknown as {
        getRoomsForParticipant: () => Promise<UUID[]>;
      }
    ).getRoomsForParticipant = async () => {
      throw new Error("rooms table locked");
    };
    const result = await runSearch(
      fake.runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MEMORY_HISTORY_DIGEST_UNAVAILABLE");
    expect(fake.reportError).toHaveBeenCalledWith(
      "MemoryAction.recentHistoryDigest.scope",
      expect.any(Error),
      expect.anything(),
    );
  });
});

describe("mixed room (gate closed)", () => {
  it("returns no digest, records suppression, and leaks no cross-room content", async () => {
    denyMixedRoom();
    const { runtime } = makeRuntime(recentSeed());
    const message = makeMessage("what have we talked about lately");
    const result = await runSearch(
      runtime,
      message,
      "what have we talked about lately",
    );

    expect(result.success).toBe(true);
    expect(revalidateOwnerExclusiveDisclosure).toHaveBeenCalled();
    expect(result.values?.historyDigestIncluded).toBe(false);
    const text = result.text ?? "";
    expect(text).not.toContain("owner-private destination verified");
    expect(text).not.toContain("Chronological conversation digest");
    // Suppression recorded on the real deny; the egress mark stays unset.
    expect(recordOwnerExclusiveSuppression).toHaveBeenCalledWith(
      message,
      "destination_not_private",
    );
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
  });

  it("returns no digest and records NO suppression when allowed on a non-owner-private basis", async () => {
    // internal_agent_turn is an allowed basis for internal work, but it is
    // NOT a verified owner-only delivery audience, so the cross-room digest
    // stays closed. It is also not a suppressed owner surface: the lane just
    // does not apply, so no suppression note is recorded.
    revalidateOwnerExclusiveDisclosure.mockResolvedValue({
      allowed: true,
      basis: "internal_agent_turn",
      audience: {},
    });
    const { runtime } = makeRuntime(recentSeed());
    const result = await runSearch(
      runtime,
      makeMessage("what have we talked about lately"),
      "what have we talked about lately",
    );

    expect(result.values?.historyDigestIncluded).toBe(false);
    expect(result.text ?? "").not.toContain(
      "Chronological conversation digest",
    );
    expect(recordOwnerExclusiveSuppression).not.toHaveBeenCalled();
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
  });
});

describe("room scoping follows the sender's cluster", () => {
  it("never renders content from a room the sender is not a participant of", async () => {
    allowOwnerPrivate();
    const now = Date.now();
    const seed: SeedMessage[] = [
      {
        roomId: DM_ROOM,
        entityId: OWNER_ID,
        text: "message in the owner's own dm",
        createdAt: now - 5 * HOUR,
      },
      {
        roomId: FOREIGN_ROOM,
        entityId: STRANGER_ID,
        text: "SECRET foreign-room content the sender must never see",
        createdAt: now - 4 * HOUR,
      },
    ];
    const fake = makeRuntime(seed, {
      roomsByEntity: new Map([
        [OWNER_ID, [DM_ROOM]],
        [STRANGER_ID, [FOREIGN_ROOM]],
      ]),
    });
    const result = await runSearch(
      fake.runtime,
      makeMessage("catch me up"),
      "catch me up",
    );

    const digestText = (result.text ?? "").slice(
      0,
      (result.text ?? "").indexOf("Showing"),
    );
    expect(digestText).toContain("message in the owner's own dm");
    expect(digestText).not.toContain("SECRET foreign-room content");
    // The store was never even asked for the foreign room.
    expect(fake.roomIdsSeenByStore().has(FOREIGN_ROOM)).toBe(false);
  });
});

describe("query classification", () => {
  const enumerationQueries = [
    "what have we talked about lately",
    "recent logs",
    "what did we discuss the last few days",
    "what have we been chatting about lately",
    "catch me up",
  ];

  for (const query of enumerationQueries) {
    it(`treats "${query}" as a time-slice query`, async () => {
      allowOwnerPrivate();
      const { runtime } = makeRuntime(recentSeed());
      const result = await runSearch(runtime, makeMessage(query), query);
      // The enumeration lane ran: the owner-private gate was consulted and,
      // being open, the digest rendered.
      expect(revalidateOwnerExclusiveDisclosure).toHaveBeenCalled();
      expect(result.values?.historyDigestIncluded).toBe(true);
    });
  }

  const offPatternQueries = [
    "find the postgres migration",
    // "lately" without a history/conversation context word is NOT a
    // time-slice request (the old bare-\blately\b pattern fired on this).
    "the tests have been flaky lately",
  ];

  for (const query of offPatternQueries) {
    it(`does NOT treat "${query}" as a time-slice query`, async () => {
      allowOwnerPrivate();
      const { runtime } = makeRuntime(recentSeed());
      const result = await runSearch(runtime, makeMessage(query), query);
      // The enumeration lane never ran: no disclosure check, no digest.
      expect(revalidateOwnerExclusiveDisclosure).not.toHaveBeenCalled();
      expect(result.values?.historyDigestIncluded).toBe(false);
    });
  }
});
