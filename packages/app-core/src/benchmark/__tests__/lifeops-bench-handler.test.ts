/**
 * Smoke tests for the LifeOpsBench HTTP handler + fake backend.
 *
 * Drives the handler with a synthetic IncomingMessage / ServerResponse pair
 * (no real HTTP socket — just collects status code + body bytes) and checks
 * the reset → message → world_state lifecycle plus state-hash mutation.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  LifeOpsBenchHandler,
  translateUmbrellaAction,
} from "../lifeops-bench-handler.js";
import { LifeOpsFakeBackend } from "../lifeops-fake-backend.js";

// --------------------------------------------------------------------------
// Fixture: a minimal LifeWorld document with one calendar + one event.
// --------------------------------------------------------------------------

const fixtureWorld = {
  seed: 7,
  now_iso: "2026-05-10T12:00:00Z",
  stores: {
    contact: {},
    email: {
      e1: {
        id: "e1",
        thread_id: "t1",
        folder: "inbox",
        from_email: "boss@example.test",
        to_emails: ["owner@example.test"],
        cc_emails: [],
        subject: "report status",
        body_plain: "How is the report?",
        sent_at: "2026-05-09T08:00:00Z",
        received_at: "2026-05-09T08:00:00Z",
        is_read: false,
        is_starred: false,
        labels: [],
        attachments: [],
      },
    },
    email_thread: {
      t1: {
        id: "t1",
        subject: "report status",
        message_ids: ["e1"],
        participants: ["boss@example.test", "owner@example.test"],
        last_activity_at: "2026-05-09T08:00:00Z",
      },
    },
    chat_message: {},
    conversation: {},
    calendar_event: {
      ev1: {
        id: "ev1",
        calendar_id: "cal_primary",
        title: "Existing meeting",
        description: "",
        location: null,
        start: "2026-05-11T10:00:00Z",
        end: "2026-05-11T11:00:00Z",
        all_day: false,
        attendees: [],
        status: "confirmed",
        visibility: "default",
        recurrence_rule: null,
        source: "google",
      },
    },
    calendar: {
      cal_primary: {
        id: "cal_primary",
        name: "Personal",
        color: "#4285F4",
        owner: "owner@example.test",
        source: "google",
        is_primary: true,
      },
    },
    reminder: {},
    reminder_list: {
      list_default: {
        id: "list_default",
        name: "Reminders",
        source: "apple-reminders",
      },
    },
    note: {},
    transaction: {},
    account: {},
    subscription: {},
    health_metric: {},
    location_point: {},
  },
};

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifeops-bench-test-"));
  const path = join(dir, "world.json");
  writeFileSync(path, JSON.stringify(fixtureWorld));
  return path;
}

// --------------------------------------------------------------------------
// Fake req/res — stays out of the way of real net plumbing.
// --------------------------------------------------------------------------

function fakeReq(method: string, body: object | null) {
  const stream = new Readable({
    read() {
      if (body !== null) this.push(JSON.stringify(body));
      this.push(null);
    },
  });
  // Minimal IncomingMessage shape the handler reads.
  return Object.assign(stream, {
    method,
    headers: {},
  }) as unknown as import("node:http").IncomingMessage;
}

function fakeRes() {
  let statusCode = 0;
  let body = "";
  let headers: Record<string, string> = {};
  const res = {
    writeHead(status: number, h?: Record<string, string>) {
      statusCode = status;
      headers = { ...(h ?? {}) };
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
    setHeader() {
      return res;
    },
    getStatus: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  };
  return res as unknown as import("node:http").ServerResponse & {
    getStatus: () => number;
    getBody: () => string;
    getHeaders: () => Record<string, string>;
  };
}

// --------------------------------------------------------------------------

describe("LifeOpsFakeBackend", () => {
  it("loads from JSON and computes a stable state hash", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const h1 = backend.stateHash();
    const h2 = backend.stateHash();
    expect(h1).toEqual(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mutates state hash when an action lands", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const before = backend.stateHash();
    backend.applyAction("calendar.create_event", {
      calendar_id: "cal_primary",
      title: "deep work",
      start: "2026-05-11T14:00:00Z",
      end: "2026-05-11T14:30:00Z",
    });
    const after = backend.stateHash();
    expect(before).not.toEqual(after);
  });

  it("throws LifeOpsBackendUnsupportedError for unknown methods", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    expect(() => backend.applyAction("not_a_real_method", {})).toThrow(
      /Unsupported lifeops fake-backend method "not_a_real_method"/,
    );
  });

  it("supports mail.search filtering by from + is:unread", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("mail.search", {
      query: "from:boss is:unread",
    });
    expect(result.ok).toBe(true);
    const matches = result.result as Array<{ id: string }>;
    expect(matches.map((m) => m.id)).toContain("e1");
  });

  it("supports promoted calendar update aliases with fuzzy title lookup", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("CALENDAR_UPDATE_EVENT", {
      event_name: "meeting",
      new_start: "2026-05-11T15:00:00Z",
      duration_minutes: 90,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      id: "ev1",
      start: "2026-05-11T15:00:00Z",
      end: "2026-05-11T16:30:00Z",
    });
  });

  it("treats a non-id eventId as a title and accepts camelCase times", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("CALENDAR", {
      subaction: "update_event",
      eventId: "Existing meeting",
      newStart: "2026-05-11T15:00:00Z",
      newEnd: "2026-05-11T17:00:00Z",
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      id: "ev1",
      start: "2026-05-11T15:00:00Z",
      end: "2026-05-11T17:00:00Z",
    });
  });

  it("accepts update_event start/end inside an updates object", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("CALENDAR_UPDATE_EVENT", {
      event_id: "ev1",
      updates: {
        start: "2026-05-11T15:00:00Z",
        end: "2026-05-11T17:00:00Z",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      id: "ev1",
      start: "2026-05-11T15:00:00Z",
      end: "2026-05-11T17:00:00Z",
    });
  });

  it("returns matching events for calendar search aliases", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("CALENDAR_SEARCH_EVENTS", {
      query: "meeting",
      time_range: {
        start: "2026-05-11T00:00:00Z",
        end: "2026-05-11T23:59:59Z",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject([{ id: "ev1" }]);
  });

  // -------------------------------------------------------------------
  // MESSAGE umbrella (P0-4) — mirrors `_u_message` in the Python runner
  // (packages/benchmarks/lifeops-bench/eliza_lifeops_bench/runner.py).
  // Previously the TS bench-server no-op'd every MESSAGE.* action, so
  // the eliza adapter scored 0.000 on mail + messages domains because
  // the state_hash component never advanced.
  // -------------------------------------------------------------------

  it("MESSAGE send (gmail) writes to email + email_thread stores", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const before = backend.stateHash();
    const result = backend.applyAction("MESSAGE", {
      operation: "send",
      source: "gmail",
      to_emails: ["alice@example.test"],
      subject: "hello",
      body: "world",
    });
    expect(result.ok).toBe(true);
    const sent = result.result as { id: string; thread_id: string };
    expect(sent.id).toMatch(/^email_auto_[0-9a-f]{12}$/);
    expect(sent.thread_id).toMatch(/^thread_auto_[0-9a-f]{12}$/);
    const doc = backend.toDocument();
    expect(doc.stores.email[sent.id]).toMatchObject({
      folder: "sent",
      subject: "hello",
      to_emails: ["alice@example.test"],
    });
    expect(doc.stores.email_thread[sent.thread_id]).toMatchObject({
      message_ids: [sent.id],
    });
    expect(backend.stateHash()).not.toEqual(before);
  });

  it("MESSAGE send (gmail) is deterministic — same kwargs => same id", () => {
    const a = LifeOpsFakeBackend.fromJsonFile(writeFixture());
    const b = LifeOpsFakeBackend.fromJsonFile(writeFixture());
    const kwargs = {
      operation: "send",
      source: "gmail",
      to_emails: ["alice@example.test"],
      subject: "hello",
      body: "world",
    };
    const ra = a.applyAction("MESSAGE", kwargs).result as { id: string };
    const rb = b.applyAction("MESSAGE", kwargs).result as { id: string };
    expect(ra.id).toEqual(rb.id);
  });

  it("MESSAGE send (imessage contact) creates conversation + chat_message", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "send",
      source: "imessage",
      target: "Alice",
      message: "hey",
    });
    expect(result.ok).toBe(true);
    const sent = result.result as { id: string; conversation_id: string };
    const doc = backend.toDocument();
    expect(doc.stores.chat_message[sent.id]).toMatchObject({
      text: "hey",
      channel: "imessage",
      conversation_id: sent.conversation_id,
    });
    expect(doc.stores.conversation[sent.conversation_id]).toMatchObject({
      channel: "imessage",
      is_group: false,
      title: "Alice",
    });
  });

  it("MESSAGE send (group) requires roomId and creates a group conversation", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "send",
      source: "slack",
      targetKind: "group",
      roomId: "room-42",
      message: "team update",
    });
    expect(result.ok).toBe(true);
    const sent = result.result as { id: string; conversation_id: string };
    expect(sent.conversation_id).toBe("room-42");
    const doc = backend.toDocument();
    expect(doc.stores.conversation["room-42"]).toMatchObject({
      is_group: true,
      channel: "slack",
    });
  });

  it("MESSAGE manage(archive) by messageId moves email to archive", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "manage",
      manageOperation: "archive",
      messageId: "e1",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ id: "e1", folder: "archive" });
    const doc = backend.toDocument();
    expect(doc.stores.email.e1.folder).toBe("archive");
  });

  it("MESSAGE manage(archive) by threadId archives every email in thread", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "manage",
      manageOperation: "archive",
      threadId: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      thread_id: "t1",
      archived_ids: ["e1"],
    });
    const doc = backend.toDocument();
    expect(doc.stores.email.e1.folder).toBe("archive");
  });

  it("MESSAGE manage(trash) flips folder to trash", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "manage",
      manageOperation: "trash",
      messageId: "e1",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ id: "e1", folder: "trash" });
  });

  it("MESSAGE manage(star) toggles is_starred and respects `starred`", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const r1 = backend.applyAction("MESSAGE", {
      operation: "manage",
      manageOperation: "star",
      messageId: "e1",
    });
    expect(r1.result).toMatchObject({ id: "e1", is_starred: true });
    const r2 = backend.applyAction("MESSAGE", {
      operation: "manage",
      manageOperation: "star",
      messageId: "e1",
      starred: false,
    });
    expect(r2.result).toMatchObject({ id: "e1", is_starred: false });
  });

  it("MESSAGE manage(mark_read) flips is_read", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "manage",
      manageOperation: "mark_read",
      messageId: "e1",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ id: "e1", is_read: true });
  });

  it("MESSAGE draft_reply (gmail) creates a draft on the parent thread", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE", {
      operation: "draft_reply",
      source: "gmail",
      messageId: "e1",
      body: "ack",
    });
    expect(result.ok).toBe(true);
    const draft = result.result as {
      id: string;
      folder: string;
      thread_id: string;
    };
    expect(draft.folder).toBe("drafts");
    expect(draft.thread_id).toBe("t1");
    const doc = backend.toDocument();
    expect(doc.stores.email[draft.id]).toMatchObject({
      folder: "drafts",
      subject: "Re: report status",
      to_emails: ["boss@example.test"],
    });
  });

  it("MESSAGE draft_reply on a non-gmail channel is a no-op", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const before = backend.stateHash();
    const result = backend.applyAction("MESSAGE", {
      operation: "draft_reply",
      source: "imessage",
      messageId: "msg-1",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      operation: "draft_reply",
      source: "imessage",
      noop: true,
    });
    expect(backend.stateHash()).toEqual(before);
  });

  // P0-4 (W6-4): MESSAGE read ops project real LifeWorld slices instead
  // of returning `{noop: true}`. State-hash stays unchanged (these are
  // reads, not writes) but the result envelope now carries enough seed
  // data for the planner to take an informed next-turn write decision.
  // Mirrors Python `_u_message`'s envelope-shaped no-op result, just with
  // populated payload fields instead of an empty marker.
  it("MESSAGE read ops return seed slices without mutating state", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const before = backend.stateHash();

    const triage = backend.applyAction("MESSAGE", {
      operation: "triage",
      source: "gmail",
    });
    expect(triage.ok).toBe(true);
    expect(triage.result).toMatchObject({
      operation: "triage",
      source: "gmail",
    });
    const triageResult = triage.result as {
      top: Array<{ id: string; priority: string }>;
    };
    expect(triageResult.top.map((m) => m.id)).toContain("e1");
    expect(triageResult.top.find((m) => m.id === "e1")?.priority).toBe("high");

    const searchInbox = backend.applyAction("MESSAGE", {
      operation: "search_inbox",
      source: "gmail",
      query: "report",
    });
    expect(searchInbox.ok).toBe(true);
    const searchResult = searchInbox.result as {
      matches: Array<{ id: string }>;
    };
    expect(searchResult.matches.map((m) => m.id)).toContain("e1");

    const listChannels = backend.applyAction("MESSAGE", {
      operation: "list_channels",
      source: "imessage",
    });
    expect(listChannels.ok).toBe(true);
    expect(listChannels.result).toMatchObject({
      operation: "list_channels",
      source: "imessage",
      channels: expect.any(Array),
    });

    const readChannel = backend.applyAction("MESSAGE", {
      operation: "read_channel",
      source: "imessage",
      channel: "conv_unknown",
    });
    expect(readChannel.ok).toBe(true);
    expect(readChannel.result).toMatchObject({
      operation: "read_channel",
      source: "imessage",
      channel: "conv_unknown",
      messages: [],
    });

    const readWith = backend.applyAction("MESSAGE", {
      operation: "read_with_contact",
      source: "imessage",
      contact: "Alice",
    });
    expect(readWith.ok).toBe(true);
    expect(readWith.result).toMatchObject({
      operation: "read_with_contact",
      source: "imessage",
      contact: "Alice",
    });

    // None of the reads should mutate state.
    expect(backend.stateHash()).toEqual(before);
  });

  it("MESSAGE throws on missing operation", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    expect(() => backend.applyAction("MESSAGE", {})).toThrow(
      /requires `operation`/,
    );
  });

  it("MESSAGE throws on unknown operation", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    expect(() =>
      backend.applyAction("MESSAGE", { operation: "frobnicate" }),
    ).toThrow(/MESSAGE\/frobnicate/);
  });

  // -------------------------------------------------------------------
  // W6-4: granular dotted `messages.*` forms route through the umbrella
  // dispatcher with `operation` injected from the suffix. Mirrors the
  // executor-side umbrella translation in `umbrellaToLowercase`.
  // -------------------------------------------------------------------

  it("messages.triage dotted form returns the same shape as MESSAGE/triage", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("messages.triage", { source: "gmail" });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      operation: "triage",
      source: "gmail",
    });
  });

  it("messages.search_inbox dotted form filters by query", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("messages.search_inbox", {
      source: "gmail",
      query: "report",
    });
    expect(result.ok).toBe(true);
    const matches = (result.result as { matches: Array<{ id: string }> })
      .matches;
    expect(matches.map((m) => m.id)).toContain("e1");
  });

  it("messages.list_channels dotted form lists conversations", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("messages.list_channels", {});
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ operation: "list_channels" });
  });

  it("messages.draft_reply dotted form mutates state (drafts)", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const before = backend.stateHash();
    const result = backend.applyAction("messages.draft_reply", {
      source: "gmail",
      messageId: "e1",
      body: "thanks",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ folder: "drafts", thread_id: "t1" });
    expect(backend.stateHash()).not.toEqual(before);
  });

  it("messages.manage dotted form archives by messageId", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("messages.manage", {
      manageOperation: "archive",
      messageId: "e1",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ id: "e1", folder: "archive" });
  });

  // -------------------------------------------------------------------
  // W6-4: P0-5 umbrella translation. The bench backend's local
  // `umbrellaToLowercase` translator handles MESSAGE_TRIAGE-style
  // granular forms (the bench handler's `translateUmbrellaAction`
  // handles CALENDAR + dotted forms at the HTTP boundary).
  // -------------------------------------------------------------------

  it("MESSAGE_TRIAGE (granular) routes through the umbrella to triage", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const result = backend.applyAction("MESSAGE_TRIAGE", { source: "gmail" });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      operation: "triage",
      source: "gmail",
    });
  });

  it("MESSAGE_SEND (granular, gmail) routes through the umbrella to send", () => {
    const path = writeFixture();
    const backend = LifeOpsFakeBackend.fromJsonFile(path);
    const before = backend.stateHash();
    const result = backend.applyAction("MESSAGE_SEND", {
      source: "gmail",
      to_emails: ["a@example.test"],
      subject: "hi",
      body: "there",
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      folder: "sent",
      subject: "hi",
    });
    expect(backend.stateHash()).not.toEqual(before);
  });
});

describe("LifeOpsBenchHandler", () => {
  it("reset → message → world_state mutates state hash and returns tool_calls", async () => {
    const path = writeFixture();
    const handler = new LifeOpsBenchHandler({
      invokePlanner: async ({ userText, backend }) => {
        // Deterministic fake planner: when the user mentions "schedule",
        // emit one calendar.create_event call.
        if (/schedule/i.test(userText)) {
          return {
            text: "Scheduled deep work.",
            toolCalls: [
              {
                id: "c1",
                name: "calendar.create_event",
                arguments: {
                  calendar_id: "cal_primary",
                  title: "deep work",
                  start: "2026-05-11T14:00:00Z",
                  end: "2026-05-11T14:30:00Z",
                },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
          };
        }
        // Touch backend to confirm reference threading works.
        return {
          text: `current world hash=${backend.stateHash().slice(0, 6)}`,
          toolCalls: [],
        };
      },
    });

    // ── reset ─────────────────────────────────────────────────────────────
    {
      const req = fakeReq("POST", {
        task_id: "scn-1",
        world_snapshot_path: path,
        now_iso: "2026-05-10T12:00:00Z",
      });
      const res = fakeRes();
      const handled = await handler.tryHandle(
        req,
        res,
        "/api/benchmark/lifeops_bench/reset",
      );
      expect(handled).toBe(true);
      expect(res.getStatus()).toBe(200);
      const parsed = JSON.parse(res.getBody());
      expect(parsed.ok).toBe(true);
      expect(parsed.task_id).toBe("scn-1");
      expect(parsed.world_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // ── world_state (before) ──────────────────────────────────────────────
    let hashBefore: string;
    {
      const req = fakeReq("GET", null);
      const res = fakeRes();
      const handled = await handler.tryHandle(
        req,
        res,
        "/api/benchmark/lifeops_bench/scn-1/world_state",
      );
      expect(handled).toBe(true);
      expect(res.getStatus()).toBe(200);
      const parsed = JSON.parse(res.getBody());
      hashBefore = parsed.world_hash;
      expect(parsed.world.stores.calendar_event).toBeDefined();
      expect(Object.keys(parsed.world.stores.calendar_event)).toEqual(["ev1"]);
    }

    // ── message that triggers calendar.create_event ───────────────────────
    {
      const req = fakeReq("POST", {
        task_id: "scn-1",
        text: "schedule a 30-minute focus block tomorrow at 10am called deep work",
        context: { tools: [] },
      });
      const res = fakeRes();
      const handled = await handler.tryHandle(
        req,
        res,
        "/api/benchmark/lifeops_bench/message",
      );
      expect(handled).toBe(true);
      expect(res.getStatus()).toBe(200);
      const parsed = JSON.parse(res.getBody());
      expect(parsed.text).toBe("Scheduled deep work.");
      expect(parsed.tool_calls).toHaveLength(1);
      expect(parsed.tool_calls[0]).toMatchObject({
        name: "calendar.create_event",
        ok: true,
      });
      expect(parsed.usage.totalTokens).toBe(14);
    }

    // ── world_state (after) — hash must have moved ────────────────────────
    {
      const req = fakeReq("GET", null);
      const res = fakeRes();
      const handled = await handler.tryHandle(
        req,
        res,
        "/api/benchmark/lifeops_bench/scn-1/world_state",
      );
      expect(handled).toBe(true);
      const parsed = JSON.parse(res.getBody());
      expect(parsed.world_hash).not.toEqual(hashBefore);
      expect(Object.keys(parsed.world.stores.calendar_event).length).toBe(2);
    }

    // ── teardown ──────────────────────────────────────────────────────────
    {
      const req = fakeReq("POST", { task_id: "scn-1" });
      const res = fakeRes();
      const handled = await handler.tryHandle(
        req,
        res,
        "/api/benchmark/lifeops_bench/teardown",
      );
      expect(handled).toBe(true);
      const parsed = JSON.parse(res.getBody());
      expect(parsed.removed).toBe(true);
    }
  });

  it("returns 404 for an unknown task_id world_state", async () => {
    const handler = new LifeOpsBenchHandler({
      invokePlanner: async () => ({ text: "", toolCalls: [] }),
    });
    const req = fakeReq("GET", null);
    const res = fakeRes();
    const handled = await handler.tryHandle(
      req,
      res,
      "/api/benchmark/lifeops_bench/nope/world_state",
    );
    expect(handled).toBe(true);
    expect(res.getStatus()).toBe(404);
  });

  it("records unsupported tool calls without crashing the run", async () => {
    const path = writeFixture();
    const handler = new LifeOpsBenchHandler({
      invokePlanner: async () => ({
        text: "trying something exotic",
        toolCalls: [
          { name: "exotic.method.not_implemented", arguments: { x: 1 } },
        ],
      }),
    });

    // reset
    {
      const req = fakeReq("POST", {
        task_id: "scn-2",
        world_snapshot_path: path,
        now_iso: "2026-05-10T12:00:00Z",
      });
      const res = fakeRes();
      await handler.tryHandle(req, res, "/api/benchmark/lifeops_bench/reset");
      expect(res.getStatus()).toBe(200);
    }

    // message: unsupported call should be reported, not crash
    const req = fakeReq("POST", { task_id: "scn-2", text: "go" });
    const res = fakeRes();
    await handler.tryHandle(req, res, "/api/benchmark/lifeops_bench/message");
    expect(res.getStatus()).toBe(200);
    const parsed = JSON.parse(res.getBody());
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0].ok).toBe(false);
    expect(parsed.tool_calls[0].error).toMatch(/unsupported/);
  });
});

// --------------------------------------------------------------------------
// P0-5: CALENDAR umbrella → calendar.<subaction> translation.
// --------------------------------------------------------------------------

describe("translateUmbrellaAction (P0-5)", () => {
  it("maps CALENDAR(subaction=create_event) to calendar.create_event and strips subaction", () => {
    const translated = translateUmbrellaAction("CALENDAR", {
      subaction: "create_event",
      calendar_id: "cal_primary",
      title: "deep work",
      start: "2026-05-11T14:00:00Z",
      end: "2026-05-11T14:30:00Z",
    });
    expect(translated.name).toBe("calendar.create_event");
    expect(translated.kwargs).toEqual({
      calendar_id: "cal_primary",
      title: "deep work",
      start: "2026-05-11T14:00:00Z",
      end: "2026-05-11T14:30:00Z",
    });
  });

  it("maps CALENDAR(subaction=delete_event) to calendar.cancel_event and strips subaction", () => {
    const translated = translateUmbrellaAction("CALENDAR", {
      subaction: "delete_event",
      id: "ev1",
    });
    expect(translated.name).toBe("calendar.cancel_event");
    expect(translated.kwargs).toEqual({ id: "ev1" });
  });

  it("passes CALENDAR without subaction through unchanged", () => {
    const kwargs = { query: "meeting" };
    const translated = translateUmbrellaAction("CALENDAR", kwargs);
    expect(translated.name).toBe("CALENDAR");
    expect(translated.kwargs).toBe(kwargs);
  });

  it("passes non-CALENDAR umbrellas through unchanged", () => {
    const kwargs = { subaction: "send", text: "hi" };
    const translated = translateUmbrellaAction("MESSAGE", kwargs);
    expect(translated.name).toBe("MESSAGE");
    expect(translated.kwargs).toBe(kwargs);
  });
});

describe("LifeOpsBenchHandler CALENDAR umbrella unwrap (P0-5)", () => {
  async function runUmbrellaScenario(args: {
    taskId: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
  }): Promise<{ worldHashBefore: string; worldHashAfter: string }> {
    const path = writeFixture();
    const handler = new LifeOpsBenchHandler({
      invokePlanner: async () => ({
        text: "ok",
        toolCalls: [
          {
            id: "c1",
            name: args.toolName,
            arguments: args.toolArguments,
          },
        ],
      }),
    });

    // reset
    {
      const req = fakeReq("POST", {
        task_id: args.taskId,
        world_snapshot_path: path,
        now_iso: "2026-05-10T12:00:00Z",
      });
      const res = fakeRes();
      await handler.tryHandle(req, res, "/api/benchmark/lifeops_bench/reset");
      expect(res.getStatus()).toBe(200);
    }

    // pre-state
    const session = handler.getSession(args.taskId);
    if (!session) throw new Error("session missing after reset");
    const worldHashBefore = session.backend.stateHash();

    // message
    {
      const req = fakeReq("POST", { task_id: args.taskId, text: "go" });
      const res = fakeRes();
      await handler.tryHandle(req, res, "/api/benchmark/lifeops_bench/message");
      expect(res.getStatus()).toBe(200);
      const parsed = JSON.parse(res.getBody());
      expect(parsed.tool_calls[0]).toMatchObject({
        name: args.toolName,
        ok: true,
      });
    }

    const worldHashAfter = session.backend.stateHash();
    return { worldHashBefore, worldHashAfter };
  }

  it("CALENDAR(subaction=create_event, …) produces the same state mutation as calendar.create_event", async () => {
    const kwargs = {
      calendar_id: "cal_primary",
      title: "deep work",
      start: "2026-05-11T14:00:00Z",
      end: "2026-05-11T14:30:00Z",
    };

    const umbrella = await runUmbrellaScenario({
      taskId: "umbrella-create",
      toolName: "CALENDAR",
      toolArguments: { subaction: "create_event", ...kwargs },
    });
    const granular = await runUmbrellaScenario({
      taskId: "granular-create",
      toolName: "calendar.create_event",
      toolArguments: kwargs,
    });

    expect(umbrella.worldHashBefore).toEqual(granular.worldHashBefore);
    expect(umbrella.worldHashAfter).toEqual(granular.worldHashAfter);
    expect(umbrella.worldHashAfter).not.toEqual(umbrella.worldHashBefore);
  });

  it("CALENDAR(subaction=delete_event, …) produces the same state mutation as calendar.cancel_event", async () => {
    const kwargs = { id: "ev1" };

    const umbrella = await runUmbrellaScenario({
      taskId: "umbrella-delete",
      toolName: "CALENDAR",
      toolArguments: { subaction: "delete_event", ...kwargs },
    });
    const granular = await runUmbrellaScenario({
      taskId: "granular-delete",
      toolName: "calendar.cancel_event",
      toolArguments: kwargs,
    });

    expect(umbrella.worldHashBefore).toEqual(granular.worldHashBefore);
    expect(umbrella.worldHashAfter).toEqual(granular.worldHashAfter);
    expect(umbrella.worldHashAfter).not.toEqual(umbrella.worldHashBefore);
  });

  it("CALENDAR without subaction does not crash and is reported as a tool_call", async () => {
    const path = writeFixture();
    const handler = new LifeOpsBenchHandler({
      invokePlanner: async () => ({
        text: "ok",
        toolCalls: [
          {
            id: "c1",
            name: "CALENDAR",
            arguments: { query: "meeting" },
          },
        ],
      }),
    });

    {
      const req = fakeReq("POST", {
        task_id: "umbrella-bare",
        world_snapshot_path: path,
        now_iso: "2026-05-10T12:00:00Z",
      });
      const res = fakeRes();
      await handler.tryHandle(req, res, "/api/benchmark/lifeops_bench/reset");
      expect(res.getStatus()).toBe(200);
    }

    const req = fakeReq("POST", { task_id: "umbrella-bare", text: "go" });
    const res = fakeRes();
    await handler.tryHandle(req, res, "/api/benchmark/lifeops_bench/message");
    expect(res.getStatus()).toBe(200);
    const parsed = JSON.parse(res.getBody());
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0].name).toBe("CALENDAR");
  });
});
