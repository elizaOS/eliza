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
import { LifeOpsBenchHandler } from "../lifeops-bench-handler.js";
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
