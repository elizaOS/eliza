import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type LinkedCalendarEventRecord,
  type LinkedCalendarLocalPort,
  type LinkedCalendarLocalSnapshot,
  type LinkedCalendarProviderPort,
  type LinkedCalendarProviderSnapshot,
  LinkedCalendarReconciler,
  type LinkedCalendarSemanticEvent,
  linkedCalendarSemanticDigest,
} from "./calendar-linked-sync.ts";

const elizaVersion: LinkedCalendarSemanticEvent = {
  title: "Dentist",
  description: "",
  location: "Main St",
  startAt: "2026-11-10T15:00:00.000Z",
  endAt: "2026-11-10T16:00:00.000Z",
  timeZone: "America/New_York",
  isAllDay: false,
  attendees: [],
};
const googleVersion: LinkedCalendarSemanticEvent = {
  ...elizaVersion,
  title: "Dentist (moved)",
  startAt: "2026-11-10T17:00:00.000Z",
  endAt: "2026-11-10T18:00:00.000Z",
};

/** In-memory Eliza calendar, Google calendar and checkpoint row. */
function harness(args: {
  local: LinkedCalendarSemanticEvent | null;
  provider: LinkedCalendarSemanticEvent | null;
  restore?: boolean;
}) {
  const writes: string[] = [];
  let local: LinkedCalendarLocalSnapshot | null = args.local
    ? { eventId: "local-1", revision: 3, event: args.local }
    : null;
  let remote: LinkedCalendarProviderSnapshot | null = args.provider
    ? { eventId: "google-1", etag: '"g2"', event: args.provider }
    : null;
  let row: LinkedCalendarEventRecord = {
    id: "link-1",
    agentId: "agent-1",
    localEventId: "local-1",
    connectorAccountId: "google-account",
    providerCalendarId: "primary",
    providerEventId: "google-1",
    providerEtag: '"g1"',
    localRevision: 3,
    lastCommonSemanticHash: "base",
    state: "conflicted",
    pendingOperation: null,
    idempotencyKey: "linked-calendar:agent-1:local-1",
    lastErrorCode: "LINKED_CALENDAR_CONCURRENT_EDIT",
    lastErrorMessage:
      "Eliza and Google changed since their last common version.",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  let saves = 0;
  const localPort: LinkedCalendarLocalPort = {
    async get() {
      return local;
    },
    async applyProviderEvent(eventId, event, expectedRevision) {
      assert.equal(local?.revision, expectedRevision);
      local = { eventId, revision: expectedRevision + 1, event };
      return local;
    },
    async delete(_eventId, expectedRevision) {
      assert.equal(local?.revision, expectedRevision);
      local = null;
    },
    ...(args.restore === false
      ? {}
      : {
          async restore(
            eventId: string,
            event: LinkedCalendarSemanticEvent,
            previousRevision: number,
          ) {
            assert.equal(local, null);
            local = { eventId, revision: previousRevision + 1, event };
            return local;
          },
        }),
  };
  const providerPort: LinkedCalendarProviderPort = {
    async get(record) {
      if (!remote) return null;
      return record.providerEventId === null ||
        record.providerEventId === remote.eventId
        ? remote
        : null;
    },
    async create(record, event) {
      writes.push(`create:${record.idempotencyKey}`);
      remote = { eventId: "google-2", etag: '"n1"', event };
      return remote;
    },
    async update(record, event) {
      writes.push(`update:${record.providerEtag}`);
      remote = { eventId: "google-1", etag: '"g3"', event };
      return remote;
    },
    async delete(record) {
      writes.push(`delete:${record.providerEtag}`);
      remote = null;
    },
  };
  const engine = new LinkedCalendarReconciler(
    {
      async save(current, patch) {
        assert.equal(current.updatedAt, row.updatedAt);
        saves += 1;
        row = { ...row, ...patch, updatedAt: `save-${saves}` };
        return row;
      },
    },
    localPort,
    providerPort,
  );
  return {
    engine,
    writes,
    row: () => row,
    local: () => local,
    remote: () => remote,
  };
}

test("a conflicted row whose sides already match becomes clean without a provider write", async () => {
  const h = harness({ local: googleVersion, provider: googleVersion });
  assert.equal(await h.engine.reconcile(h.row()), "clean");
  assert.deepEqual(h.writes, []);
  assert.equal(h.row().state, "clean");
  assert.equal(h.row().providerEtag, '"g2"');
  assert.equal(
    h.row().lastCommonSemanticHash,
    await linkedCalendarSemanticDigest(googleVersion),
  );
  assert.equal(h.row().lastErrorCode, null);
  assert.equal(await h.engine.reconcile(h.row()), "clean");
  assert.deepEqual(h.writes, []);
});

test("a conflicted row whose sides differ stays conflicted", async () => {
  const h = harness({ local: elizaVersion, provider: googleVersion });
  const before = h.row();
  assert.equal(await h.engine.reconcile(before), "conflicted");
  assert.deepEqual(h.writes, []);
  assert.equal(h.row(), before);
});

test("keep_eliza after an Eliza delete removes the Google event at the version read now", async () => {
  const h = harness({ local: null, provider: googleVersion });
  assert.equal(await h.engine.resolveConflict(h.row(), "keep_eliza"), "pushed");
  assert.deepEqual(h.writes, ['delete:"g2"']);
  assert.equal(h.remote(), null);
  assert.equal(h.row().state, "paused");
  assert.equal(await h.engine.reconcile(h.row()), "paused");
  assert.deepEqual(h.writes, ['delete:"g2"']);
});

test("keep_google after an Eliza delete restores the event from Google", async () => {
  const h = harness({ local: null, provider: googleVersion });
  assert.equal(
    await h.engine.resolveConflict(h.row(), "keep_google"),
    "pulled",
  );
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.local(), {
    eventId: "local-1",
    revision: 4,
    event: googleVersion,
  });
  assert.equal(h.row().state, "clean");
  assert.equal(h.row().localRevision, 4);
  assert.equal(await h.engine.reconcile(h.row()), "clean");
  assert.deepEqual(h.writes, []);
});

test("keep_google after an Eliza delete is quarantined when the host cannot restore", async () => {
  const h = harness({ local: null, provider: googleVersion, restore: false });
  assert.equal(
    await h.engine.resolveConflict(h.row(), "keep_google"),
    "quarantined",
  );
  assert.equal(h.row().lastErrorCode, "LINKED_LOCAL_EVENT_MISSING");
});

test("keep_eliza after a Google delete recreates the event under a new key", async () => {
  const h = harness({ local: elizaVersion, provider: null });
  assert.equal(await h.engine.resolveConflict(h.row(), "keep_eliza"), "pushed");
  assert.equal(h.writes.length, 1);
  assert.match(
    h.writes[0] ?? "",
    /^create:linked-calendar:recreate:[0-9a-f]{64}$/,
  );
  assert.equal(h.row().state, "clean");
  assert.equal(h.row().providerEventId, "google-2");
  assert.equal(await h.engine.reconcile(h.row()), "clean");
  assert.equal(h.writes.length, 1);
});

test("keep_google after a Google delete removes the Eliza event and pauses the link", async () => {
  const h = harness({ local: elizaVersion, provider: null });
  assert.equal(
    await h.engine.resolveConflict(h.row(), "keep_google"),
    "pulled",
  );
  assert.deepEqual(h.writes, []);
  assert.equal(h.local(), null);
  assert.equal(h.row().state, "paused");
  assert.equal(await h.engine.reconcile(h.row()), "paused");
});

test("a conflict with both events deleted pauses the link", async () => {
  const h = harness({ local: null, provider: null });
  assert.equal(await h.engine.resolveConflict(h.row(), "keep_eliza"), "paused");
  assert.deepEqual(h.writes, []);
  assert.equal(h.row().state, "paused");
});
