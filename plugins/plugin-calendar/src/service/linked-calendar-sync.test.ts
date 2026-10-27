/**
 * Integration-backed contract tests for durable Eliza-to-Google event links.
 * Repository cases use an in-memory PGlite database; reconciliation cases use
 * deterministic local/provider ports around the real state machine.
 */

import { PGlite } from "@electric-sql/pglite";
import { linkedCalendarSemanticDigest } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GoogleLinkedCalendarProviderPort,
  type LinkedCalendarCheckpointStore,
  type LinkedCalendarEventRecord,
  type LinkedCalendarLocalPort,
  type LinkedCalendarLocalSnapshot,
  type LinkedCalendarProviderPort,
  type LinkedCalendarProviderSnapshot,
  LinkedCalendarReconciler,
  LinkedCalendarRepository,
  type LinkedCalendarSemanticEvent,
  linkedCalendarSemanticHash,
} from "./linked-calendar-sync.js";
import { ensureLinkedCalendarEventTable } from "./migration.js";

const baseEvent: LinkedCalendarSemanticEvent = {
  title: "School pickup",
  description: "Front entrance",
  location: "Concord School",
  startAt: "2026-09-01T19:00:00.000Z",
  endAt: "2026-09-01T20:00:00.000Z",
  timeZone: "America/New_York",
  isAllDay: false,
  attendees: [],
};

it("keeps semantic text and digest identical across English and Swedish default collation", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(
    new URL(
      "../../../../packages/contracts/src/calendar-linked-sync.ts",
      import.meta.url,
    ),
  );
  const event = {
    ...baseEvent,
    attendees: [
      "z@example.com",
      "ä@example.com",
      "a@example.com",
      "å@example.com",
      "ö@example.com",
    ].map((email) => ({ email })),
  };
  const script = `import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';const source=stripTypeScriptTypes(readFileSync(${JSON.stringify(path)},'utf8'),{mode:'transform'});const {linkedCalendarSemanticText,linkedCalendarSemanticDigest}=await import('data:text/javascript,'+encodeURIComponent(source));const event=${JSON.stringify(event)};console.log(JSON.stringify({collation:event.attendees.map(a=>a.email).sort((a,b)=>a.localeCompare(b)),text:linkedCalendarSemanticText(event),digest:await linkedCalendarSemanticDigest(event)}));`;
  const run = (locale: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--no-warnings", "--input-type=module", "-e", script],
        {
          encoding: "utf8",
          env: { ...process.env, LANG: locale, LC_ALL: locale },
        },
      ),
    );
  const english = run("en_US.UTF-8"),
    swedish = run("sv_SE.UTF-8");
  expect(english.collation).not.toEqual(swedish.collation);
  expect(english.text).toBe(swedish.text);
  expect(english.digest).toBe(swedish.digest);
});

it("the shared engine preserves opaque phone revisions through push and pull", async () => {
  let current: LinkedCalendarEventRecord<string> = {
    ...record(),
    localRevision: "phone-rev-1",
  };
  let local: LinkedCalendarLocalSnapshot<string> = {
    eventId: current.localEventId,
    revision: "phone-rev-1",
    event: structuredClone(baseEvent),
  };
  let remote: LinkedCalendarProviderSnapshot | null = null,
    creates = 0;
  const checkpoints: LinkedCalendarCheckpointStore<string> = {
    async save(expected, patch) {
      expect(expected.updatedAt).toBe(current.updatedAt);
      current = { ...current, ...patch, updatedAt: crypto.randomUUID() };
      return current;
    },
  };
  const localPort: LinkedCalendarLocalPort<string> = {
    async get() {
      return local;
    },
    async applyProviderEvent(id, event, expected) {
      expect(id).toBe(local.eventId);
      expect(expected).toBe(local.revision);
      local = { eventId: id, event, revision: "phone-rev-2" };
      return local;
    },
    async delete() {
      throw Error("Not requested");
    },
  };
  const provider: LinkedCalendarProviderPort<string> = {
    async get() {
      return remote;
    },
    async create(_record, event) {
      creates++;
      remote = { eventId: "google-event", etag: '"v1"', event };
      return remote;
    },
    async update() {
      throw Error("Not requested");
    },
    async delete() {
      throw Error("Not requested");
    },
  };
  const sync = new LinkedCalendarReconciler<string>(
    checkpoints,
    localPort,
    provider,
  );
  expect(await sync.reconcile(current)).toBe("pushed");
  expect(creates).toBe(1);
  expect(current.localRevision).toBe("phone-rev-1");
  expect(await linkedCalendarSemanticDigest(baseEvent)).toBe(
    linkedCalendarSemanticHash(baseEvent),
  );
  expect(await sync.reconcile(current)).toBe("clean");
  expect(creates).toBe(1);
  if (!remote) throw new Error("Provider create was not captured");
  remote = {
    ...remote,
    etag: '"v2"',
    event: { ...baseEvent, title: "Updated in Google" },
  };
  expect(await sync.reconcile(current)).toBe("pulled");
  expect(local.event.title).toBe("Updated in Google");
  expect(current.localRevision).toBe("phone-rev-2");
});

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
  updateExpectedEtag?: string;
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
        if (
          args.updateExpectedEtag &&
          _record.providerEtag !== args.updateExpectedEtag
        )
          throw Object.assign(new Error("Provider revision changed"), {
            outcome: "precondition_failed",
            code: "GOOGLE_CALENDAR_PRECONDITION_FAILED",
          });
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
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    db = await PGlite.create();
    await db.exec("CREATE SCHEMA app_calendar");
    await ensureLinkedCalendarEventTable(
      async (statement) =>
        (await db.query<Record<string, unknown>>(statement)).rows,
    );
    runtime = { adapter: { db: drizzle(db) } } as unknown as IAgentRuntime;
    repository = new LinkedCalendarRepository(runtime);
  });

  afterEach(async () => {
    await db.close();
  });

  it("persists a local-first link across repository recreation and deduplicates replay", async () => {
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
    const restarted = await new LinkedCalendarRepository(
      runtime,
    ).getByLocalEvent("agent-1", "local-1");
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

  it.each([
    {
      connectorAccountId: "replacement-account",
      providerCalendarId: "primary",
    },
    {
      connectorAccountId: "google-1",
      providerCalendarId: "replacement-calendar",
    },
  ])(
    "rejects a different destination without reactivating the old mapping: %j",
    async (destination) => {
      const args = {
        agentId: "agent-1",
        localEventId: "local-1",
        connectorAccountId: "google-1",
        providerCalendarId: "primary",
        localRevision: 1,
      };
      const original = await repository.create(args);
      const paused = await repository.pause(original);

      await expect(
        repository.create({ ...args, ...destination, localRevision: 9 }),
      ).rejects.toThrow();
      expect(
        await repository.getByLocalEvent(args.agentId, args.localEventId),
      ).toEqual(paused);
      expect(await repository.listActionable(args.agentId)).toEqual([]);

      const resumed = await repository.create({ ...args, localRevision: 2 });
      expect(resumed).toMatchObject({
        id: original.id,
        connectorAccountId: args.connectorAccountId,
        providerCalendarId: args.providerCalendarId,
        localRevision: 2,
        state: "dirty",
        pendingOperation: "create",
      });
    },
  );

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

  it.each(["", null])(
    "preserves nullable checkpoint text %j through reload and a subsequent save",
    async (value) => {
      const initial = await repository.create({
        agentId: "agent-1",
        localEventId: "local-1",
        connectorAccountId: "google-1",
        providerCalendarId: "primary",
        localRevision: 1,
      });
      const patch = {
        providerEventId: value,
        providerEtag: value,
        lastCommonSemanticHash: value,
        lastErrorCode: value,
        lastErrorMessage: value,
      };
      const saved = await repository.save(initial, patch);
      const raw = await db.query(
        "SELECT provider_event_id, provider_etag, last_common_semantic_hash, last_error_code, last_error_message FROM app_calendar.linked_calendar_events",
      );
      expect(raw.rows).toEqual([
        {
          provider_event_id: value,
          provider_etag: value,
          last_common_semantic_hash: value,
          last_error_code: value,
          last_error_message: value,
        },
      ]);
      expect(saved).toMatchObject(patch);
      const reloaded = await new LinkedCalendarRepository(runtime).getById(
        initial.agentId,
        initial.id,
      );
      expect(reloaded).toEqual(saved);
      if (!reloaded) throw new Error("Saved checkpoint was not reloaded");
      const paused = await repository.pause(reloaded);
      expect(paused).toMatchObject({
        ...patch,
        state: "paused",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      expect(await repository.getById(initial.agentId, initial.id)).toEqual(
        paused,
      );
    },
  );

  it("can pause a quarantined provider failure with an empty error message", async () => {
    const initial = await repository.create({
      agentId: "agent-1",
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      localRevision: 1,
    });
    const testPorts = ports({ createError: new Error("") });
    const reconciler = new LinkedCalendarReconciler(
      repository,
      testPorts.localPort,
      testPorts.providerPort,
    );
    expect(await reconciler.reconcile(initial)).toBe("quarantined");
    const raw = await db.query(
      "SELECT state, last_error_message FROM app_calendar.linked_calendar_events",
    );
    expect(raw.rows).toEqual([
      { state: "quarantined", last_error_message: "" },
    ]);
    const reloaded = await repository.getById(initial.agentId, initial.id);
    expect(reloaded?.lastErrorMessage).toBe("");
    if (!reloaded) throw new Error("Quarantined checkpoint was not reloaded");
    const paused = await repository.pause(reloaded);
    expect(paused.state).toBe("paused");
    expect(testPorts.counts()).toEqual({ creates: 1, updates: 0 });
    expect(await repository.getById(initial.agentId, initial.id)).toEqual(
      paused,
    );
  });

  it("rejects a stale create checkpoint when a delete shares its timestamp", async () => {
    const now = new Date("2026-09-23T10:00:00.000Z");
    const initial = await repository.create({
      agentId: "agent-1",
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      localRevision: 1,
      now,
    });
    const deletion = await repository.markLocalDirty({
      agentId: "agent-1",
      localEventId: "local-1",
      localRevision: 2,
      operation: "delete",
      now,
    });

    expect(deletion).toMatchObject({
      updatedAt: initial.updatedAt,
      localRevision: 2,
      state: "dirty",
      pendingOperation: "delete",
    });
    await expect(
      repository.save(
        initial,
        { state: "quarantined", pendingOperation: "create" },
        now,
      ),
    ).rejects.toThrow("Concurrent checkpoint update rejected");
    expect(
      await repository.getByLocalEvent("agent-1", "local-1"),
    ).toMatchObject({
      updatedAt: initial.updatedAt,
      localRevision: 2,
      state: "dirty",
      pendingOperation: "delete",
    });
  });
});

describe("LinkedCalendarReconciler", () => {
  it("never reads or writes the provider for a retained local-only link", async () => {
    const initial = record({ state: "local_only", pendingOperation: null });
    const store = new MemoryStore(initial);
    const unreachable = async (): Promise<never> => {
      throw new Error(
        "Local-only reconciliation must not touch an external port",
      );
    };
    const reconciler = new LinkedCalendarReconciler(
      store,
      {
        get: unreachable,
        applyProviderEvent: unreachable,
        delete: unreachable,
      },
      {
        get: unreachable,
        create: unreachable,
        update: unreachable,
        delete: unreachable,
      },
    );
    expect(await reconciler.reconcile(initial)).toBe("paused");
    expect(await reconciler.resolveConflict(initial, "keep_google")).toBe(
      "paused",
    );
    expect(store.current).toEqual(initial);
  });

  it("recovers an accepted create from provider state without replaying the write", async () => {
    const store = new MemoryStore(record({ state: "quarantined" }));
    const testPorts = ports({
      provider: { eventId: "accepted-create", etag: '"g1"', event: baseEvent },
    });
    const reconciler = new LinkedCalendarReconciler(
      store,
      testPorts.localPort,
      testPorts.providerPort,
    );
    expect(await reconciler.recoverDispatch(store.current)).toBe(true);
    expect(store.current.providerEventId).toBe("accepted-create");
    expect(store.current.pendingOperation).toBeNull();
    expect(store.current.state).toBe("clean");
    expect(testPorts.counts()).toEqual({ creates: 0, updates: 0 });
  });

  it("keeps an absent create unresolved instead of interpreting absence as permission to retry", async () => {
    const initial = record({ state: "quarantined" });
    const store = new MemoryStore(initial);
    const testPorts = ports({});
    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).recoverDispatch(initial),
    ).toBe(false);
    expect(store.current).toBe(initial);
    expect(testPorts.counts()).toEqual({ creates: 0, updates: 0 });
  });

  it("requires a changed ETag before settling an uncertain conditional update", async () => {
    const initial = record({
      state: "quarantined",
      pendingOperation: "update",
      providerEventId: "existing",
      providerEtag: '"g1"',
    });
    const store = new MemoryStore(initial);
    const unchanged = ports({
      provider: { eventId: "existing", etag: '"g1"', event: baseEvent },
    });
    expect(
      await new LinkedCalendarReconciler(
        store,
        unchanged.localPort,
        unchanged.providerPort,
      ).recoverDispatch(initial),
    ).toBe(false);
    expect(store.current).toBe(initial);
    const changed = ports({
      provider: { eventId: "existing", etag: '"g2"', event: baseEvent },
    });
    expect(
      await new LinkedCalendarReconciler(
        store,
        changed.localPort,
        changed.providerPort,
      ).recoverDispatch(initial),
    ).toBe(true);
    expect(store.current.providerEtag).toBe('"g2"');
    expect(changed.counts()).toEqual({ creates: 0, updates: 0 });
  });

  it("settles a pending deletion only after both local and provider events are absent", async () => {
    const initial = record({
      state: "quarantined",
      pendingOperation: "delete",
      providerEventId: "deleted-event",
    });
    const store = new MemoryStore(initial);
    const stillPresent = ports({
      local: null,
      provider: { eventId: "deleted-event", etag: '"g1"', event: baseEvent },
    });
    expect(
      await new LinkedCalendarReconciler(
        store,
        stillPresent.localPort,
        stillPresent.providerPort,
      ).recoverDispatch(initial),
    ).toBe(false);
    expect(store.current).toBe(initial);
    const absent = ports({ local: null, provider: null });
    expect(
      await new LinkedCalendarReconciler(
        store,
        absent.localPort,
        absent.providerPort,
      ).recoverDispatch(initial),
    ).toBe(true);
    expect(store.current.state).toBe("paused");
    expect(store.current.pendingOperation).toBeNull();
  });

  it("retains the pending checkpoint when provider verification fails", async () => {
    const initial = record({ state: "quarantined" });
    const store = new MemoryStore(initial);
    const testPorts = ports({});
    const failure = new Error("Calendar access was revoked");
    const provider = {
      ...testPorts.providerPort,
      get: async () => {
        throw failure;
      },
    };
    await expect(
      new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        provider,
      ).recoverDispatch(initial),
    ).rejects.toBe(failure);
    expect(store.current).toBe(initial);
    expect(testPorts.counts()).toEqual({ creates: 0, updates: 0 });
  });

  it("retains a divergent provider event for explicit conflict review", async () => {
    const initial = record({ state: "quarantined" });
    const store = new MemoryStore(initial);
    const testPorts = ports({
      provider: {
        eventId: "existing",
        etag: '"g2"',
        event: { ...baseEvent, title: "External edit" },
      },
    });
    expect(
      await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).recoverDispatch(initial),
    ).toBe(false);
    expect(store.current).toBe(initial);
    expect(testPorts.local()?.event.title).toBe(baseEvent.title);
  });

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

  it.each(['"g5"', null])(
    "keeps the selected local value only against a fresh provider revision (%s)",
    async (etag) => {
      const store = new MemoryStore(
        record({
          state: "conflicted",
          providerEventId: "google-event-1",
          providerEtag: '"g1"',
          lastCommonSemanticHash: "old",
        }),
      );
      const testPorts = ports({
        local: {
          eventId: "local-1",
          revision: 4,
          event: { ...baseEvent, title: "Local wins" },
        },
        provider: {
          eventId: "google-event-1",
          etag,
          event: { ...baseEvent, title: "Provider edit" },
        },
        updateExpectedEtag: '"g5"',
      });
      const result = await new LinkedCalendarReconciler(
        store,
        testPorts.localPort,
        testPorts.providerPort,
      ).resolveConflict(store.current, "keep_eliza");
      expect(result).toBe(etag ? "pushed" : "quarantined");
      expect(testPorts.counts().updates).toBe(etag ? 1 : 0);
      if (etag)
        expect(store.current).toMatchObject({
          state: "clean",
          localRevision: 4,
          providerEtag: '"g2"',
        });
      else
        expect(store.current.lastErrorCode).toBe(
          "LINKED_PROVIDER_REVISION_MISSING",
        );
    },
  );

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

describe("all-day reconciliation", () => {
  it("refreshes an obsolete checkpoint without rewriting equal local and provider events", async () => {
    const event = {
      ...baseEvent,
      isAllDay: true,
      startAt: "2026-11-01T00:00:00.000Z",
      endAt: "2026-11-03T00:00:00.000Z",
    };
    const store = new MemoryStore(
      record({
        providerEventId: "google-event-1",
        state: "clean",
        pendingOperation: null,
        lastCommonSemanticHash: "prior-semantic-normalization",
      }),
    );
    const harness = ports({
      local: { eventId: "local-1", revision: 1, event },
      provider: {
        eventId: "google-event-1",
        etag: '"g1"',
        event: { ...event, timeZone: null },
      },
    });
    const reconciler = new LinkedCalendarReconciler(
      store,
      harness.localPort,
      harness.providerPort,
    );
    expect(await reconciler.reconcile(store.current)).toBe("clean");
    expect(await reconciler.reconcile(store.current)).toBe("clean");
    expect(harness.counts()).toEqual({ creates: 0, updates: 0 });
    expect(store.current.lastCommonSemanticHash).toBe(
      linkedCalendarSemanticHash(event),
    );
  });

  it("does not rewrite date-only events when Google omits their timezone", async () => {
    const localEvent = {
      ...baseEvent,
      isAllDay: true,
      startAt: "2026-11-01T00:00:00.000Z",
      endAt: "2026-11-03T00:00:00.000Z",
    };
    const providerEvent = { ...localEvent, timeZone: null };
    const store = new MemoryStore(
      record({
        providerEventId: "google-event-1",
        state: "clean",
        pendingOperation: null,
        lastCommonSemanticHash: linkedCalendarSemanticHash(providerEvent),
      }),
    );
    const harness = ports({
      local: { eventId: "local-1", revision: 1, event: localEvent },
      provider: {
        eventId: "google-event-1",
        etag: '"g1"',
        event: providerEvent,
      },
    });
    const reconciler = new LinkedCalendarReconciler(
      store,
      harness.localPort,
      harness.providerPort,
    );
    expect(await reconciler.reconcile(store.current)).toBe("clean");
    expect(await reconciler.reconcile(store.current)).toBe("clean");
    expect(harness.counts()).toEqual({ creates: 0, updates: 0 });
  });

  it("repairs an unchanged provider event written with legacy timed semantics once", async () => {
    const timed = {
      ...baseEvent,
      startAt: "2026-11-01T00:00:00.000Z",
      endAt: "2026-11-02T00:00:00.000Z",
    };
    const localEvent = { ...timed, isAllDay: true };
    const initial = record({
      providerEventId: "google-event-1",
      state: "clean",
      pendingOperation: null,
      lastCommonSemanticHash: linkedCalendarSemanticHash(timed),
    });
    const store = new MemoryStore(initial);
    const harness = ports({
      local: { eventId: "local-1", revision: 1, event: localEvent },
      provider: { eventId: "google-event-1", etag: '"g1"', event: timed },
    });
    const reconciler = new LinkedCalendarReconciler(
      store,
      harness.localPort,
      harness.providerPort,
    );
    expect(await reconciler.reconcile(store.current)).toBe("pushed");
    expect(await reconciler.reconcile(store.current)).toBe("clean");
    expect(harness.counts()).toEqual({ creates: 0, updates: 1 });
    expect(harness.local()?.event.isAllDay).toBe(true);
  });

  it("pulls a provider-only all-day change without discarding its date semantics", async () => {
    const store = new MemoryStore(
      record({
        providerEventId: "google-event-1",
        state: "clean",
        pendingOperation: null,
        lastCommonSemanticHash: linkedCalendarSemanticHash(baseEvent),
      }),
    );
    const harness = ports({
      provider: {
        eventId: "google-event-1",
        etag: '"g2"',
        event: { ...baseEvent, isAllDay: true },
      },
    });
    const reconciler = new LinkedCalendarReconciler(
      store,
      harness.localPort,
      harness.providerPort,
    );
    expect(await reconciler.reconcile(store.current)).toBe("pulled");
    expect(harness.local()?.event.isAllDay).toBe(true);
    expect(harness.counts()).toEqual({ creates: 0, updates: 0 });
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

  it("preserves all-day date boundaries through create, update, and readback", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const respond = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        id: "school-event",
        calendarId: "primary",
        title: input.title,
        start: `${input.start}T00:00:00.000Z`,
        end: `${input.end}T00:00:00.000Z`,
        isAllDay: true,
        timeZone: "America/New_York",
        metadata: { etag: '"school-1"' },
      };
    };
    const google = {
      createEvent: respond,
      updateEvent: respond,
    } as unknown as IGoogleWorkspaceService;
    const port = new GoogleLinkedCalendarProviderPort(google);
    const school = {
      ...baseEvent,
      isAllDay: true,
      startAt: "2026-10-31T00:00:00.000Z",
      endAt: "2026-11-03T00:00:00.000Z",
    };
    const created = await port.create(record(), school);
    expect(calls[0]).toMatchObject({ start: "2026-10-31", end: "2026-11-03" });
    expect(created.event).toMatchObject({
      isAllDay: true,
      startAt: school.startAt,
      endAt: school.endAt,
    });
    await port.update(
      record({ providerEventId: created.eventId, providerEtag: created.etag }),
      { ...school, endAt: "2026-11-04T00:00:00.000Z" },
    );
    expect(calls[1]).toMatchObject({
      start: "2026-10-31",
      end: "2026-11-04",
      expectedEtag: '"school-1"',
    });
  });

  it("never clears a provider recurrence when the local event has none", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const google = {
      async updateEvent(input: Record<string, unknown>) {
        calls.push(input);
        return {
          id: "google-series",
          calendarId: "primary",
          title: input.title,
          start: input.start,
          end: input.end,
          recurrence: ["RRULE:FREQ=WEEKLY"],
          metadata: { etag: '"series-2"' },
        };
      },
    } as unknown as IGoogleWorkspaceService;
    const port = new GoogleLinkedCalendarProviderPort(google);
    const updated = await port.update(
      record({ providerEventId: "google-series", providerEtag: '"series-1"' }),
      { ...baseEvent, title: "Kept from Eliza" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("recurrence");
    expect(updated.event.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
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

it("recurrence changes are part of linked event semantics without changing ordinary checkpoints", async () => {
  expect(linkedCalendarSemanticHash({ ...baseEvent, recurrence: [] })).toBe(
    linkedCalendarSemanticHash(baseEvent),
  );
  expect(
    linkedCalendarSemanticHash({
      ...baseEvent,
      recurrence: ["RRULE:FREQ=DAILY"],
    }),
  ).not.toBe(linkedCalendarSemanticHash(baseEvent));
  expect(
    await linkedCalendarSemanticDigest({
      ...baseEvent,
      recurrence: ["RRULE:FREQ=WEEKLY"],
    }),
  ).toBe(
    linkedCalendarSemanticHash({
      ...baseEvent,
      recurrence: ["RRULE:FREQ=WEEKLY"],
    }),
  );
});

import {
  CalendarAgentWriteRefused,
  type CalendarSyncRequest,
  calendarAgentWrite,
  type ManagedCalendarHostApi,
} from "./managed-calendar-host.js";
// The real private transport and shared host adapter surround the existing reconciler.
import { createManagedCalendarRead } from "./managed-calendar-read.js";
import { ManagedLinkedCalendarProviderPort } from "./managed-linked-calendar.js";

function managedFixture() {
  const scope = "a".repeat(64),
    grantId = `alpha-google:${scope}`;
  let accountId = "managed-account",
    remote: LinkedCalendarProviderSnapshot | null = null;
  let lostReply = false,
    swapAccountAfterCapabilities = false,
    changeCapabilityProtocol = false;
  const capabilityVersions: number[] = [];
  let alterReply:
    | ((result: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  const commands: CalendarSyncRequest[] = [];
  const client: ManagedCalendarHostApi = {
    async googleCalendarFeed() {
      throw Error("Linked sync must use the exact sync endpoint");
    },
    async googleCalendarSync(command) {
      commands.push(structuredClone(command));
      const envelope = (value: Record<string, unknown>) => ({
        version: 1,
        calendarId: command.selection.calendarId,
        providerExactlyOnce: false,
        ...value,
      });
      if (command.kind === "capabilities") {
        const result = {
          calendarId: command.selection.calendarId,
          accountId,
          read: true,
          write: true,
          idempotentCreate: true,
          conditionalWrites: true,
          providerExactlyOnce: false,
        };
        if (swapAccountAfterCapabilities) {
          swapAccountAfterCapabilities = false;
          accountId = "different-account";
        }
        const version =
          changeCapabilityProtocol && capabilityVersions.length ? 2 : 1;
        capabilityVersions.push(version);
        return envelope({ ...result, version });
      }
      if (
        command.selection.grantId !== "real-owner-grant" ||
        command.selection.accountId !== accountId
      )
        throw Error("Wrong owner binding");
      if (command.kind === "get") return envelope({ event: remote });
      if (command.kind === "update" || command.kind === "delete") {
        if (command.expectedEtag !== remote?.etag)
          throw Object.assign(new Error("Precondition failed"), {
            name: "CloudProtocolError",
            code: "http",
            status: 412,
            data: {
              code: "CALENDAR_SYNC_PRECONDITION_FAILED",
              outcome: "precondition_failed",
            },
          });
      }
      if (command.kind === "delete") {
        remote = null;
        return envelope({ deleted: true });
      }
      remote = Object.assign(
        {
          eventId: "managed-event",
          etag: '"managed-v1"',
          event: structuredClone(command.event),
        },
        { visibility: "private", remindersDisabled: true },
      );
      if (lostReply) {
        lostReply = false;
        throw TypeError("Synthetic lost acknowledgement after acceptance");
      }
      return envelope({ event: remote });
    },
  };
  const request = (async (_url, init) => {
    const input = JSON.parse(String(init?.body)).calendar;
    try {
      const result = await calendarAgentWrite(
        client,
        "real-owner-grant",
        scope,
        input,
        new AbortController().signal,
        "alpha-google",
      );
      return Response.json(
        input.operation === "linked-sync" && alterReply
          ? alterReply(result as Record<string, unknown>)
          : result,
      );
    } catch (error) {
      return error instanceof CalendarAgentWriteRefused
        ? Response.json({ calendarFailure: error.refusal })
        : Response.json({ error: "Synthetic host refusal" }, { status: 409 });
    }
  }) as typeof fetch;
  const transport = createManagedCalendarRead(
    {
      ELIZA_MANAGED_CALENDAR_READ_BROKER:
        "http://127.0.0.1:1/__alpha-owner-gmail",
      ELIZA_API_TOKEN: "a".repeat(64),
    },
    request,
  );
  if (!transport) throw Error("Missing fixture transport");
  return {
    grantId,
    client,
    transport,
    commands,
    provider: new ManagedLinkedCalendarProviderPort(transport, false),
    capabilityVersions,
    changeCapabilityProtocol: () => {
      changeCapabilityProtocol = true;
    },
    alterReply: (
      alter: (result: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      alterReply = alter;
    },
    loseReply: () => {
      lostReply = true;
    },
    swapAccount: () => {
      swapAccountAfterCapabilities = true;
    },
    setRemote: (event: LinkedCalendarProviderSnapshot) => {
      remote = event;
    },
  };
}

describe("managed owner linked Calendar provider", () => {
  it.each(["create", "update"] as const)(
    "rejects malformed %s event fields before provider dispatch",
    async (kind) => {
      for (const patch of [
        { title: undefined },
        { startAt: "not-a-date" },
        { endAt: baseEvent.startAt },
        { timeZone: 12 },
        { isAllDay: "false" },
        { attendees: [{ email: 42 }] },
        { attendees: [{ email: "guest@acme.com", optional: "yes" }] },
        { recurrence: [12] },
        { deleted: "false" },
      ]) {
        const f = managedFixture();
        await expect(
          calendarAgentWrite(
            f.client,
            "real-owner-grant",
            "a".repeat(64),
            {
              operation: "linked-sync",
              grantId: f.grantId,
              calendarId: "calendar",
              accountId: "managed-account",
              command: {
                kind,
                ...(kind === "create"
                  ? { idempotencyKey: "stable-key" }
                  : { eventId: "managed-event", expectedEtag: '"managed-v1"' }),
                event: { ...baseEvent, ...patch },
              },
            },
            new AbortController().signal,
            "alpha-google",
          ),
        ).rejects.toThrow("Invalid linked Calendar semantic event");
        expect(f.commands.some((command) => command.kind === kind)).toBe(false);
      }
    },
  );

  it("refuses a fresh capability protocol change before linked-sync dispatch", async () => {
    const f = managedFixture();
    f.changeCapabilityProtocol();
    await expect(
      f.provider.create(
        { ...record(), connectorAccountId: f.grantId },
        baseEvent,
      ),
    ).rejects.toThrow();
    expect(f.capabilityVersions).toEqual([1, 2]);
    expect(
      f.commands.filter((command) =>
        ["create", "update", "delete"].includes(command.kind),
      ),
    ).toHaveLength(0);
  });

  it.each([
    ["version", 2],
    ["calendarId", "different-calendar"],
    ["providerExactlyOnce", true],
  ] as const)(
    "refuses a mismatched %s even when the event result is absent",
    async (field, value) => {
      const f = managedFixture();
      f.alterReply((result) => ({ ...result, [field]: value }));
      await expect(
        f.provider.get({
          ...record(),
          connectorAccountId: f.grantId,
          providerEventId: null,
        }),
      ).rejects.toThrow("selected protocol and calendar");
    },
  );

  it.each([
    ["visibility", "default"],
    ["remindersDisabled", false],
  ] as const)(
    "refuses an unconfirmed create %s receipt without repeating the create",
    async (field, value) => {
      const f = managedFixture();
      f.alterReply((result) => ({
        ...result,
        event: { ...(result.event as Record<string, unknown>), [field]: value },
      }));
      await expect(
        f.provider.create(
          { ...record(), connectorAccountId: f.grantId },
          baseEvent,
        ),
      ).rejects.toThrow("create privacy");
      expect(
        f.commands.filter((command) => command.kind === "create"),
      ).toHaveLength(1);
    },
  );

  it("pushes through the existing reconciler and preserves the exact grant, stable key and checkpoint", async () => {
    const f = managedFixture();
    let current = {
      ...record(),
      connectorAccountId: f.grantId,
      providerEventId: null,
      providerEtag: null,
      state: "dirty" as const,
      pendingOperation: "create" as const,
      lastCommonSemanticHash: null,
    } as LinkedCalendarEventRecord;
    const store: LinkedCalendarCheckpointStore = {
      async save(_expected, patch) {
        current = { ...current, ...patch };
        return current;
      },
    };
    const local: LinkedCalendarLocalPort = {
      async get() {
        return {
          eventId: current.localEventId,
          revision: current.localRevision,
          event: baseEvent,
        };
      },
      async applyProviderEvent() {
        throw Error("Unexpected local replacement");
      },
      async delete() {
        throw Error("Unexpected local deletion");
      },
    };
    const engine = new LinkedCalendarReconciler(store, local, f.provider);
    expect(await engine.reconcile(current)).toBe("pushed");
    expect(current).toMatchObject({
      state: "clean",
      providerEventId: "managed-event",
      providerEtag: '"managed-v1"',
      pendingOperation: null,
    });
    const creates = f.commands.filter((command) => command.kind === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      selection: {
        grantId: "real-owner-grant",
        calendarId: current.providerCalendarId,
        accountId: "managed-account",
      },
      idempotencyKey: current.idempotencyKey,
      event: baseEvent,
    });
    await engine.reconcile(current);
    expect(
      f.commands.filter((command) => command.kind === "create"),
    ).toHaveLength(1);
  });

  it("quarantines a lost acknowledgement without repeating the provider create", async () => {
    const f = managedFixture();
    f.loseReply();
    let current = {
      ...record(),
      connectorAccountId: f.grantId,
      providerEventId: null,
      providerEtag: null,
      state: "dirty",
      pendingOperation: "create",
      lastCommonSemanticHash: null,
    } as LinkedCalendarEventRecord;
    const engine = new LinkedCalendarReconciler(
      {
        async save(_expected, patch) {
          current = { ...current, ...patch };
          return current;
        },
      },
      {
        async get() {
          return {
            eventId: current.localEventId,
            revision: current.localRevision,
            event: baseEvent,
          };
        },
        async applyProviderEvent() {
          throw Error("Unexpected replacement");
        },
        async delete() {
          throw Error("Unexpected deletion");
        },
      },
      f.provider,
    );
    expect(await engine.reconcile(current)).toBe("quarantined");
    expect(await engine.reconcile(current)).toBe("quarantined");
    expect(
      f.commands.filter((command) => command.kind === "create"),
    ).toHaveLength(1);
    expect((await f.provider.get(current))?.eventId).toBe("managed-event");
    expect(
      f.commands.filter((command) => command.kind === "get").at(-1),
    ).toMatchObject({ reference: { idempotencyKey: current.idempotencyKey } });
  });

  it("refuses an account swap and nested selection before a provider mutation", async () => {
    const f = managedFixture();
    f.swapAccount();
    await expect(
      f.provider.create(
        { ...record(), connectorAccountId: f.grantId },
        baseEvent,
      ),
    ).rejects.toThrow();
    expect(f.commands.some((command) => command.kind === "create")).toBe(false);
    await expect(
      calendarAgentWrite(
        f.client,
        "real-owner-grant",
        "a".repeat(64),
        {
          operation: "linked-sync",
          grantId: f.grantId,
          calendarId: "calendar",
          accountId: "different-account",
          command: {
            kind: "create",
            idempotencyKey: "stable-key",
            event: baseEvent,
            selection: { accountId: "attacker" },
          },
        },
        new AbortController().signal,
        "alpha-google",
      ),
    ).rejects.toThrow("Unsupported");
    expect(f.commands.some((command) => command.kind === "create")).toBe(false);
  });

  it("preserves conditional-write refusal and keeps managed deletion off by default", async () => {
    const f = managedFixture();
    f.setRemote({ eventId: "managed-event", etag: '"new"', event: baseEvent });
    const current = {
      ...record(),
      connectorAccountId: f.grantId,
      providerEventId: "managed-event",
      providerEtag: '"old"',
    };
    await expect(f.provider.update(current, baseEvent)).rejects.toMatchObject({
      outcome: "precondition_failed",
      code: "CALENDAR_SYNC_PRECONDITION_FAILED",
    });
    await expect(f.provider.delete(current)).rejects.toMatchObject({
      outcome: "not_accepted",
      code: "CALENDAR_SYNC_DELETE_UNAVAILABLE",
    });
    expect(f.commands.some((command) => command.kind === "delete")).toBe(false);
  });
});
