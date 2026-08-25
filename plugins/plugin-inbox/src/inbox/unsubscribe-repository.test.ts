import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRawSqlMock = vi.hoisted(() => vi.fn());

vi.mock("../db/sql.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/sql.ts")>();
  return { ...actual, executeRawSql: executeRawSqlMock };
});

import type { EmailUnsubscribeRecord } from "./email-unsubscribe-types";
import { InboxUnsubscribeRepository } from "./unsubscribe-repository";

function makeRecord(
  overrides: Partial<EmailUnsubscribeRecord> = {},
): EmailUnsubscribeRecord {
  return {
    id: "u1",
    agentId: "a1",
    senderEmail: "spam@example.com",
    senderDisplay: "Spam",
    senderDomain: "example.com",
    listId: "list-1",
    method: "http_one_click",
    status: "succeeded",
    httpStatusCode: 200,
    httpFinalUrl: "https://example.com/unsub",
    filterCreated: true,
    filterId: "f1",
    threadsTrashed: 2,
    errorMessage: null,
    metadata: { source: "gmail" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

const FULL_ROW: Record<string, unknown> = {
  id: "u1",
  agent_id: "a1",
  sender_email: "spam@example.com",
  sender_display: "Spam",
  sender_domain: "example.com",
  list_id: "list-1",
  method: "http_one_click",
  status: "succeeded",
  http_status_code: 200,
  http_final_url: "https://example.com/unsub",
  filter_created: true,
  filter_id: "f1",
  threads_trashed: 2,
  error_message: null,
  metadata_json: '{"source":"gmail"}',
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

describe("InboxUnsubscribeRepository", () => {
  const runtime = { agentId: "agent-1" } as never;
  const repo = new InboxUnsubscribeRepository(runtime);

  beforeEach(() => {
    executeRawSqlMock.mockReset();
    executeRawSqlMock.mockResolvedValue([]);
  });

  describe("listEmailUnsubscribes limit clamp", () => {
    async function limitFor(args: { limit?: number }): Promise<string> {
      executeRawSqlMock.mockResolvedValue([]);
      await repo.listEmailUnsubscribes(args);
      return executeRawSqlMock.mock.calls[0][1] as string;
    }

    it("uses the default of 100 when no limit is given", async () => {
      expect(await limitFor({})).toContain("LIMIT 100");
    });

    it("clamps negative limits up to 1", async () => {
      expect(await limitFor({ limit: -5 })).toContain("LIMIT 1");
      expect(await limitFor({ limit: 0 })).toContain("LIMIT 1");
    });

    it("clamps over-large limits down to 500", async () => {
      expect(await limitFor({ limit: 10_000 })).toContain("LIMIT 500");
    });

    it("truncates fractional limits before clamping", async () => {
      expect(await limitFor({ limit: 3.7 })).toContain("LIMIT 3");
    });

    it("falls back to the default when the limit is NaN (defect: Math.trunc(NaN) bypassed the clamp)", async () => {
      expect(await limitFor({ limit: Number.NaN })).toContain("LIMIT 100");
    });

    it("falls back to the default for Infinity instead of emitting an invalid literal", async () => {
      expect(await limitFor({ limit: Number.POSITIVE_INFINITY })).toContain(
        "LIMIT 100",
      );
    });
  });

  describe("SQL injection boundary", () => {
    it("escapes single quotes in sender-controlled email values", async () => {
      await repo.createEmailUnsubscribe(
        makeRecord({
          senderEmail: "x'; DROP TABLE app_inbox.life_email_unsubscribes;--",
        }),
      );
      const sql = executeRawSqlMock.mock.calls[0][1] as string;
      expect(sql).toContain(
        "'x''; DROP TABLE app_inbox.life_email_unsubscribes;--'",
      );
      expect(sql).not.toContain("'x'; DROP TABLE");
    });

    it("quotes the agent id when scoping queries", async () => {
      await repo.listEmailUnsubscribes();
      const sql = executeRawSqlMock.mock.calls[0][1] as string;
      expect(sql).toContain("agent_id = 'agent-1'");
    });

    it("escapes quotes in list ids and error messages", async () => {
      await repo.createEmailUnsubscribe(
        makeRecord({ listId: "l'ist", errorMessage: "boom'boom" }),
      );
      const sql = executeRawSqlMock.mock.calls[0][1] as string;
      expect(sql).toContain("'l''ist'");
      expect(sql).toContain("'boom''boom'");
    });
  });

  describe("findEmailUnsubscribeBySender", () => {
    it("normalizes the sender email (trim + lowercase) before matching", async () => {
      executeRawSqlMock.mockResolvedValue([FULL_ROW]);
      await repo.findEmailUnsubscribeBySender("  Spam@Example.COM  ");
      const sql = executeRawSqlMock.mock.calls[0][1] as string;
      expect(sql).toContain("sender_email = 'spam@example.com'");
    });

    it("returns null when no row matches", async () => {
      executeRawSqlMock.mockResolvedValue([]);
      expect(await repo.findEmailUnsubscribeBySender("x@y.z")).toBeNull();
    });
  });

  describe("getEmailUnsubscribe row mapping", () => {
    it("maps a full row into the record shape", async () => {
      executeRawSqlMock.mockResolvedValue([FULL_ROW]);
      const record = await repo.getEmailUnsubscribe("u1");
      expect(record).toMatchObject({
        id: "u1",
        agentId: "a1",
        senderEmail: "spam@example.com",
        method: "http_one_click",
        status: "succeeded",
        httpStatusCode: 200,
        filterCreated: true,
        threadsTrashed: 2,
        metadata: { source: "gmail" },
      });
    });

    it("applies fail-safe defaults for missing optional fields", async () => {
      executeRawSqlMock.mockResolvedValue([
        {
          id: "u2",
          agent_id: "a1",
          sender_email: "x@y.z",
          sender_display: "X",
          sender_domain: null,
          list_id: null,
          method: null,
          status: null,
          http_status_code: null,
          http_final_url: null,
          filter_created: null,
          filter_id: null,
          threads_trashed: null,
          error_message: null,
          metadata_json: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ]);
      const record = await repo.getEmailUnsubscribe("u2");
      expect(record).toMatchObject({
        method: "manual_only",
        status: "failed",
        httpStatusCode: null,
        httpFinalUrl: null,
        filterCreated: false,
        threadsTrashed: 0,
        metadata: {},
      });
    });

    it("returns null when the query returns no rows", async () => {
      executeRawSqlMock.mockResolvedValue([]);
      expect(await repo.getEmailUnsubscribe("missing")).toBeNull();
    });

    it("surfaces corrupt metadata JSON loudly instead of mis-parsing it", async () => {
      executeRawSqlMock.mockResolvedValue([
        { ...FULL_ROW, metadata_json: "{not json" },
      ]);
      await expect(repo.getEmailUnsubscribe("u1")).rejects.toThrow(
        "[InboxSql] Invalid JSON value",
      );
    });

    it("maps a non-object JSON metadata value to an empty record", async () => {
      executeRawSqlMock.mockResolvedValue([
        { ...FULL_ROW, metadata_json: "42" },
      ]);
      await expect(repo.getEmailUnsubscribe("u1")).rejects.toThrow(
        "[InboxSql] Expected JSON object",
      );
    });
  });

  describe("createEmailUnsubscribe", () => {
    it("serializes metadata as JSON and binds all columns", async () => {
      await repo.createEmailUnsubscribe(makeRecord());
      const sql = executeRawSqlMock.mock.calls[0][1] as string;
      expect(sql).toContain('"source":"gmail"');
      expect(sql).toContain("'spam@example.com'");
      expect(sql).toContain("TRUE");
    });
  });
});
