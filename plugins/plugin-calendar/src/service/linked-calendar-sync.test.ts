/**
 * Integration-backed contract tests for durable Eliza-to-Google event links.
 * Repository cases use an in-memory PGlite database; reconciliation cases use
 * deterministic local/provider ports around the real state machine.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import { beforeEach, describe, expect, it } from "vitest";
import type { RawSqlQuery } from "../internal/sql.js";
import {
  GoogleLinkedCalendarProviderPort,
  type LinkedCalendarCheckpointStore,
  type LinkedCalendarEventRecord,
  type LinkedCalendarLocalSnapshot,
  type LinkedCalendarProviderSnapshot,
  LinkedCalendarReconciler,
  LinkedCalendarRepository,
  type LinkedCalendarSemanticEvent,
} from "./linked-calendar-sync.js";

const baseEvent: LinkedCalendarSemanticEvent = {
  title: "School pickup",
  description: "Front entrance",
  location: "Concord School",
  startAt: "2026-09-01T19:00:00.000Z",
  endAt: "2026-09-01T20:00:00.000Z",
  timeZone: "America/New_York",
  attendees: [],
};

function record(
  overrides: Partial<LinkedCalendarEventRecord> = {},
): LinkedCalendarEventRecord {
  return {
    id: "link-1",
    agentId: "agent-1",
    localEventId: "local-1",
    connectorAccountId: "google-1",
    providerCalendarId: "primary",
    providerEventId: null,
    providerEtag: null,
    localRevision: 1,
    lastCommonSemanticHash: null,
    state: "dirty",
    pendingOperation: "create",
    idempotencyKey: "linked-calendar:agent-1:local-1",
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryStore implements LinkedCalendarCheckpointStore {
  current: LinkedCalendarEventRecord;
  private revision = 0;
  constructor(initial: LinkedCalendarEventRecord) {
    this.current = initial;
  }
  async save(
    current: LinkedCalendarEventRecord,
    patch: Partial<LinkedCalendarEventRecord>,
  ) {
    expect(current.updatedAt).toBe(this.current.updatedAt);
    this.revision += 1;
    this.current = {
      ...this.current,
      ...patch,
      updatedAt: `memory-${this.revision}`,
    };
    return this.current;
  }
}

function ports(args: {
  local?: LinkedCalendarLocalSnapshot | null;
  provider?: LinkedCalendarProviderSnapshot | null;
  createError?: unknown;
  localApplyError?: unknown;
  localDeleteError?: unknown;
}) {
  let local =
    args.local === undefined
      ? { eventId: "local-1", revision: 1, event: baseEvent }
      : args.local;
  let provider = args.provider === undefined ? null : args.provider;
  let creates = 0;
  let updates = 0;
  return {
    localPort: {
      async get() {
        return local;
      },
      async applyProviderEvent(
        eventId: string,
        event: LinkedCalendarSemanticEvent,
        expectedRevision: number,
      ) {
        if (args.localApplyError) throw args.localApplyError;
        local = { eventId, event, revision: expectedRevision + 1 };
        return local;
      },
      async delete(_eventId: string, _expectedRevision: number) {
        if (args.localDeleteError) throw args.localDeleteError;
        local = null;
      },
    },
    providerPort: {
      async get() {
        return provider;
      },
      async create(
        _record: LinkedCalendarEventRecord,
        event: LinkedCalendarSemanticEvent,
      ) {
        creates += 1;
        if (args.createError) throw args.createError;
        provider = { eventId: "google-event-1", etag: '"g1"', event };
        return provider;
      },
      async update(
        _record: LinkedCalendarEventRecord,
        event: LinkedCalendarSemanticEvent,
      ) {
        updates += 1;
        provider = { eventId: "google-event-1", etag: '"g2"', event };
        return provider;
      },
      async delete() {
        provider = null;
      },
    },
    counts: () => ({ creates, updates }),
    local: () => local,
  };
}

describe("LinkedCalendarRepository with PGlite", () => {
  let db: PGlite;
  let repository: LinkedCalendarRepository;

  beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE SCHEMA app_calendar;
      CREATE TABLE app_calendar.linked_calendar_events (
        id text PRIMARY KEY, agent_id text NOT NULL, local_event_id text NOT NULL,
        connector_account_id text NOT NULL, provider_calendar_id text NOT NULL,
        provider_event_id text, provider_etag text, local_revision integer NOT NULL DEFAULT 0,
        last_common_semantic_hash text, state text NOT NULL DEFAULT 'dirty',
        pending_operation text, idempotency_key text NOT NULL, last_error_code text,
        last_error_message text, created_at text NOT NULL, updated_at text NOT NULL,
        UNIQUE(agent_id, local_event_id),
        UNIQUE(agent_id, connector_account_id, provider_calendar_id, provider_event_id)
      );`);
    const runtime = {
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) => {
            const sql = query.queryChunks
              .map((chunk) => chunk.value ?? "")
              .join("");
            return db.query(sql);
          },
        },
      },
    } as unknown as IAgentRuntime;
    repository = new LinkedCalendarRepository(runtime);
  });

  it("persists a local-first link across repository restart and deduplicates replay", async () => {
    const first = await repository.create({
      agentId: "agent-1",
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      localRevision: 1,
    });
    const replay = await repository.create({
      agentId: "agent-1",
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      localRevision: 1,
    });
    const restarted = await repository.getByLocalEvent("agent-1", "local-1");
    expect(replay.id).toBe(first.id);
    expect(restarted?.idempotencyKey).toBe("linked-calendar:agent-1:local-1");
  });

  it("retains mappings but pauses them when an account disconnects", async () => {
    await repository.create({
      agentId: "agent-1",
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      localRevision: 1,
    });
    expect(await repository.pauseAccount("agent-1", "google-1")).toBe(1);
    expect(
      (await repository.getByLocalEvent("agent-1", "local-1"))?.state,
    ).toBe("paused");
  });

  it("ignores an out-of-order local revision and keeps one durable operation", async () => {
    await repository.create({
      agentId: "agent-1",
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      localRevision: 1,
    });
    await repository.markLocalDirty({
      agentId: "agent-1",
      localEventId: "local-1",
      localRevision: 3,
    });
    const staleReplay = await repository.markLocalDirty({
      agentId: "agent-1",
      localEventId: "local-1",
      localRevision: 2,
    });
    expect(staleReplay).toMatchObject({
      localRevision: 3,
      state: "dirty",
      pendingOperation: "create",
    });
    expect(await repository.listActionable("agent-1")).toHaveLength(1);
  });
});

describe("LinkedCalendarReconciler", () => {
  it("pushes local-first exactly once and treats replay as clean", async () => {
    const store = new MemoryStore(record());
    const testPorts = ports({});
    const reconciler = new LinkedCalendarReconciler(
      store,
      testPorts.localPort,
      testPorts.providerPort,
    );
    expect(await reconciler.reconcile(store.current)).toBe("pushed");
    expect(await reconciler.reconcile(store.current)).toBe("clean");
    expect(testPorts.counts()).toEqual({ creates: 1, updates: 0 });
  });

  it("pulls a provider-first change into Eliza", async () => {
    const initial = record({
      state: "clean",
      providerEventId: "google-event-1",
      providerEtag: '"g1"',
      lastCommonSemanticHash: "old",
    });
    const store = new MemoryStore(initial);
    const changed = { ...baseEvent, title: "Changed in Google" };
    const testPorts = ports({
      local: { eventId: "local-1", revision: 1, event: baseEvent },
      provider: { eventId: "google-event-1", etag: '"g2"', event: changed },
    });
    // Establish local as the last-common version, so only the provider changed.
    const { linkedCalendarSemanticHash } = await import(
      "./linked-calendar-sync.js"
    );
    store.current.lastCommonSemanticHash =
      linkedCalendarSemanticHash(baseEvent);
    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).reconcile(store.current),
    ).toBe("pulled");
    expect(testPorts.local()?.event.title).toBe("Changed in Google");
  });

  it("detects concurrent edits without overwriting either side", async () => {
    const store = new MemoryStore(
      record({ state: "clean", lastCommonSemanticHash: "old" }),
    );
    const testPorts = ports({
      local: {
        eventId: "local-1",
        revision: 2,
        event: { ...baseEvent, title: "Local edit" },
      },
      provider: {
        eventId: "google-event-1",
        etag: '"g2"',
        event: { ...baseEvent, title: "Remote edit" },
      },
    });
    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).reconcile(store.current),
    ).toBe("conflicted");
    expect(store.current.state).toBe("conflicted");
    expect(testPorts.counts()).toEqual({ creates: 0, updates: 0 });
  });

  it("quarantines an unknown provider outcome instead of replaying the write", async () => {
    const store = new MemoryStore(record());
    const testPorts = ports({
      createError: new Error("socket closed after request body"),
    });
    const reconciler = new LinkedCalendarReconciler(
      store,
      testPorts.localPort,
      testPorts.providerPort,
    );
    expect(await reconciler.reconcile(store.current)).toBe("quarantined");
    expect(await reconciler.reconcile(store.current)).toBe("quarantined");
    expect(testPorts.counts().creates).toBe(1);
    expect(store.current.lastErrorCode).toBe(
      "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
    );
  });

  it("replays a durable delete after restart even though the local row is gone", async () => {
    const store = new MemoryStore(
      record({
        state: "dirty",
        pendingOperation: "delete",
        providerEventId: "google-event-1",
        providerEtag: '"g1"',
      }),
    );
    const testPorts = ports({
      local: null,
      provider: {
        eventId: "google-event-1",
        etag: '"g1"',
        event: baseEvent,
      },
    });

    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).reconcile(store.current),
    ).toBe("pushed");
    expect(store.current).toMatchObject({
      state: "paused",
      pendingOperation: null,
      lastErrorCode: "LINKED_CALENDAR_LOCAL_EVENT_DELETED",
    });
  });

  it("maps a provider precondition rejection to an explicit conflict", async () => {
    const store = new MemoryStore(record());
    const testPorts = ports({
      createError: {
        outcome: "precondition_failed",
        code: "GOOGLE_PRECONDITION",
        message: "etag changed",
      },
    });
    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).reconcile(store.current),
    ).toBe("conflicted");
    expect(store.current.state).toBe("conflicted");
  });

  it("quarantines a provider pull when the local CAS rejects a stale revision", async () => {
    const initial = record({
      state: "clean",
      providerEventId: "google-event-1",
      providerEtag: '"g1"',
    });
    const { linkedCalendarSemanticHash } = await import(
      "./linked-calendar-sync.js"
    );
    initial.lastCommonSemanticHash = linkedCalendarSemanticHash(baseEvent);
    const store = new MemoryStore(initial);
    const testPorts = ports({
      provider: {
        eventId: "google-event-1",
        etag: '"g2"',
        event: { ...baseEvent, title: "Provider edit" },
      },
      localApplyError: new Error("compare-and-swap rejected"),
    });

    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).reconcile(store.current),
    ).toBe("quarantined");
    expect(store.current).toMatchObject({
      state: "quarantined",
      lastErrorCode: "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
    });
  });

  it("resolves a stale two-sided conflict using the owner's selected provider value", async () => {
    const store = new MemoryStore(
      record({
        state: "conflicted",
        providerEventId: "google-event-1",
        providerEtag: '"g1"',
        lastCommonSemanticHash: "old",
      }),
    );
    const providerEdit = { ...baseEvent, title: "Provider wins" };
    const testPorts = ports({
      local: {
        eventId: "local-1",
        revision: 4,
        event: { ...baseEvent, title: "Local stale edit" },
      },
      provider: {
        eventId: "google-event-1",
        etag: '"g5"',
        event: providerEdit,
      },
    });

    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).resolveConflict(store.current, "keep_google"),
    ).toBe("pulled");
    expect(testPorts.local()).toMatchObject({
      revision: 5,
      event: { title: "Provider wins" },
    });
    expect(store.current).toMatchObject({
      state: "clean",
      providerEtag: '"g5"',
      localRevision: 5,
    });
  });

  it("retains and pauses the mapping after a watch pull observes provider deletion", async () => {
    const { linkedCalendarSemanticHash } = await import(
      "./linked-calendar-sync.js"
    );
    const store = new MemoryStore(
      record({
        state: "clean",
        providerEventId: "google-event-1",
        providerEtag: '"g1"',
        lastCommonSemanticHash: linkedCalendarSemanticHash(baseEvent),
      }),
    );
    const testPorts = ports({ provider: null });

    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).reconcile(store.current),
    ).toBe("pulled");
    expect(testPorts.local()).toBeNull();
    expect(store.current).toMatchObject({
      state: "paused",
      providerEventId: "google-event-1",
      lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
    });
  });
});

describe("GoogleLinkedCalendarProviderPort", () => {
  it("uses the durable link key for idempotent create and the saved etag for update", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const google = {
      async createEvent(input: Record<string, unknown>) {
        calls.push(input);
        return {
          id: "google-event-1",
          calendarId: "primary",
          title: input.title,
          start: input.start,
          end: input.end,
          metadata: { etag: '"g1"' },
        };
      },
      async updateEvent(input: Record<string, unknown>) {
        calls.push(input);
        return {
          id: "google-event-1",
          calendarId: "primary",
          title: input.title,
          start: input.start,
          end: input.end,
          metadata: { etag: '"g2"' },
        };
      },
    } as unknown as IGoogleWorkspaceService;
    const port = new GoogleLinkedCalendarProviderPort(google);
    const created = await port.create(record(), baseEvent);
    await port.update(
      record({ providerEventId: created.eventId, providerEtag: created.etag }),
      { ...baseEvent, title: "Updated" },
    );
    expect(calls[0]).toMatchObject({
      idempotencyKey: "linked-calendar:agent-1:local-1",
      sendUpdates: "none",
    });
    expect(calls[1]).toMatchObject({
      eventId: "google-event-1",
      expectedEtag: '"g1"',
      sendUpdates: "none",
    });
  });

  it("maps provider 410 to an absent snapshot for watch/full-resync reconciliation", async () => {
    const google = {
      async getEvent() {
        throw { status: 410 };
      },
    } as unknown as IGoogleWorkspaceService;
    const port = new GoogleLinkedCalendarProviderPort(google);
    await expect(
      port.get(record({ providerEventId: "deleted-google-event" })),
    ).resolves.toBeNull();
  });
});
