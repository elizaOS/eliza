/**
 * Covers logsAction: op dispatch, search query construction / limit clamp /
 * tag intersection, delete clearing, and set_level overrides. HTTP is the
 * action's real boundary (the log buffer lives on the server), so fetch is
 * stubbed to capture the outbound request and return a canned buffer; the
 * action itself is the system under test. Deterministic: no server runs.
 */
import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createSelfApiRequestHeaders } from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { logsAction } from "./logs.ts";

interface StubEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: HeadersInit | undefined;
}

type FetchOutcome =
  | { ok: true; status?: number; body: unknown }
  | { ok: false; status: number; body?: unknown }
  | { throw: unknown };

const TS = 1_700_000_000_000;
const runtime = { agentId: "agent-1" } as unknown as IAgentRuntime;
const message = { content: { text: "" }, roomId: "room-default" } as Memory;

let restoreFetch: (() => void) | undefined;
let originalFetch: typeof fetch | undefined;
const captured: CapturedRequest[] = [];

function stubFetch(outcome: FetchOutcome): void {
  if (!originalFetch) originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: init?.headers,
    });
    if ("throw" in outcome) {
      throw outcome.throw;
    }
    if (!outcome.ok) {
      return {
        ok: false,
        status: outcome.status,
        json: async () => outcome.body ?? { error: "fail" },
      } as Response;
    }
    return {
      ok: true,
      status: outcome.status ?? 200,
      json: async () => outcome.body,
    } as Response;
  }) as typeof fetch;
  restoreFetch = () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    originalFetch = undefined;
  };
}

function makeEntries(
  count: number,
  extra: Partial<StubEntry> = {},
): StubEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: TS + index * 1000,
    level: "error",
    message: `entry-${index}`,
    source: "discord",
    tags: [],
    ...extra,
  }));
}

async function run(
  parameters: Record<string, unknown> = {},
  options?: {
    runtime?: IAgentRuntime;
    message?: Memory;
    callback?: HandlerCallback;
    omitParameters?: boolean;
  },
): Promise<ActionResult> {
  const result = await logsAction.handler(
    options?.runtime ?? runtime,
    options?.message ?? message,
    undefined,
    options?.omitParameters ? undefined : ({ parameters } as never),
    options?.callback,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  captured.length = 0;
});

describe("logsAction metadata", () => {
  it("is the LOGS owner-gated polymorphic action", () => {
    expect(logsAction.name).toBe("LOGS");
    expect(logsAction.contexts).toEqual([
      "admin",
      "agent_internal",
      "settings",
    ]);
    expect(logsAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(logsAction.similes).toEqual(
      expect.arrayContaining([
        "SEARCH_LOGS",
        "DELETE_LOGS",
        "LOG_LEVEL",
        "CLEAR_LOGS",
        "SET_LOG_LEVEL",
      ]),
    );
  });

  it("validate always succeeds", async () => {
    expect(await logsAction.validate?.(runtime, message)).toBe(true);
  });
});

describe("logsAction op dispatch", () => {
  it("rejects a missing op", async () => {
    const result = await run({});
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_INVALID" });
    expect(result.data).toMatchObject({
      actionName: "LOGS",
      validOps: ["search", "delete", "set_level"],
    });
    expect(result.text).toContain("Unknown LOGS op: undefined");
    expect(captured).toHaveLength(0);
  });

  it("rejects an unknown op and does not call fetch", async () => {
    const result = await run({ action: "tail" });
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_INVALID" });
    expect(result.text).toContain("Unknown LOGS op: tail");
    expect(captured).toHaveLength(0);
  });

  it("prefers action over subaction over op", async () => {
    stubFetch({
      ok: true,
      body: { entries: [], sources: [], tags: [] },
    });
    const result = await run({
      action: "search",
      subaction: "delete",
      op: "delete",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ op: "search" });
    expect(captured[0]?.method).toBe("GET");
  });

  it("falls back to subaction, then op", async () => {
    stubFetch({ ok: true, body: { cleared: 3 } });
    const viaSubaction = await run({ subaction: "delete", op: "search" });
    expect(viaSubaction.data).toMatchObject({ op: "delete" });
    expect(captured[0]?.method).toBe("DELETE");

    captured.length = 0;
    const viaOp = await run({ op: "delete" });
    expect(viaOp.data).toMatchObject({ op: "delete" });
    expect(captured[0]?.method).toBe("DELETE");
  });

  it("treats missing parameters the same as an empty op", async () => {
    const result = await run({}, { omitParameters: true });
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_INVALID" });
  });
});

describe("logsAction search", () => {
  it("GETs /api/logs with no query when filters are absent", async () => {
    stubFetch({
      ok: true,
      body: { entries: [], sources: [], tags: [] },
    });
    const result = await run({ action: "search" });
    expect(result.success).toBe(true);
    expect(captured[0]?.url).toMatch(/^http:\/\/localhost:\d+\/api\/logs$/);
    expect(captured[0]?.headers).toEqual(createSelfApiRequestHeaders());
    expect(String(result.text)).toContain("No log entries match.");
    expect(String(result.text)).toContain("Filters applied: none");
    expect(String(result.text)).toContain("at most 200");
    expect(result.values).toMatchObject({ count: 0, shown: 0 });
  });

  it("puts source, searchable level, first tag, and numeric since on the query", async () => {
    stubFetch({
      ok: true,
      body: { entries: [], sources: ["agent"], tags: ["http"] },
    });
    await run({
      action: "search",
      source: "agent",
      level: "warn",
      tags: ["http", "slow"],
      since: "1700000000000",
    });
    const url = new URL(captured[0]?.url ?? "");
    expect(url.searchParams.get("source")).toBe("agent");
    expect(url.searchParams.get("level")).toBe("warn");
    expect(url.searchParams.get("tag")).toBe("http");
    expect(url.searchParams.getAll("tag")).toEqual(["http"]);
    expect(url.searchParams.get("since")).toBe("1700000000000");
  });

  it("does not send search level=trace (not in SEARCH_LEVELS)", async () => {
    stubFetch({
      ok: true,
      body: { entries: [], sources: [], tags: [] },
    });
    const result = await run({ action: "search", level: "trace" });
    const url = new URL(captured[0]?.url ?? "");
    expect(url.searchParams.has("level")).toBe(false);
    expect(String(result.text)).not.toContain("level=trace");
  });

  it("parses ISO since, omits unparseable values, and Date.parses non-positive numerics", async () => {
    stubFetch({
      ok: true,
      body: { entries: [], sources: [], tags: [] },
    });

    await run({ action: "search", since: "2024-01-15T12:00:00.000Z" });
    expect(new URL(captured[0]?.url ?? "").searchParams.get("since")).toBe(
      String(Date.parse("2024-01-15T12:00:00.000Z")),
    );

    await run({ action: "search", since: "not-a-date" });
    expect(new URL(captured[1]?.url ?? "").searchParams.has("since")).toBe(
      false,
    );

    // Number("0") is not > 0, so parseSince falls through to Date.parse("0").
    await run({ action: "search", since: "0" });
    expect(new URL(captured[2]?.url ?? "").searchParams.get("since")).toBe(
      String(Date.parse("0")),
    );

    await run({ action: "search", since: "-5" });
    expect(new URL(captured[3]?.url ?? "").searchParams.get("since")).toBe(
      String(Date.parse("-5")),
    );
  });

  it("trims empty tags and intersects remaining tags client-side", async () => {
    const entries: StubEntry[] = [
      {
        timestamp: TS,
        level: "info",
        message: "both",
        source: "agent",
        tags: ["http", "slow"],
      },
      {
        timestamp: TS + 1000,
        level: "info",
        message: "http-only",
        source: "agent",
        tags: ["http"],
      },
      {
        timestamp: TS + 2000,
        level: "info",
        message: "neither",
        source: "agent",
        tags: ["other"],
      },
    ];
    stubFetch({
      ok: true,
      body: { entries, sources: ["agent"], tags: ["http", "slow"] },
    });
    const result = await run({
      action: "search",
      tags: ["  http  ", "", "   ", "slow"],
    });
    const url = new URL(captured[0]?.url ?? "");
    expect(url.searchParams.get("tag")).toBe("http");
    const shown = (result.data as { entries: StubEntry[] }).entries;
    expect(shown.map((entry) => entry.message)).toEqual(["both"]);
    expect(String(result.text)).toContain("tags=http+slow");
    expect(result.values).toMatchObject({ count: 1, shown: 1 });
  });

  it("does not client-filter when only one tag remains", async () => {
    const entries = makeEntries(2, { tags: ["http"] });
    entries[1] = { ...entries[1], tags: ["other"], message: "other" };
    stubFetch({
      ok: true,
      body: { entries, sources: ["discord"], tags: ["http"] },
    });
    const result = await run({ action: "search", tags: ["http"] });
    const shown = (result.data as { entries: StubEntry[] }).entries;
    expect(shown).toHaveLength(2);
  });

  it("returns a single matching entry with singular copy and newest-last preview", async () => {
    const entries: StubEntry[] = [
      {
        timestamp: TS,
        level: "info",
        message: "only-one",
        source: "agent",
        tags: ["http"],
      },
    ];
    stubFetch({
      ok: true,
      body: { entries, sources: ["agent"], tags: ["http"] },
    });
    const result = await run({ action: "search" });
    expect(String(result.text)).toContain("Showing 1 of 1 matching entry");
    expect(String(result.text)).toContain("newest last");
    expect(String(result.text)).toContain(
      `${new Date(TS).toISOString()} INFO  agent [http]: only-one`,
    );
    expect(result.values).toMatchObject({
      count: 1,
      shown: 1,
      totalSources: 1,
    });
  });

  it("clamps limit into [1, 200] and takes the newest tail", async () => {
    stubFetch({
      ok: true,
      body: {
        entries: makeEntries(5),
        sources: ["discord"],
        tags: [],
      },
    });

    const def = await run({ action: "search" });
    expect((def.data as { entries: StubEntry[] }).entries).toHaveLength(5);
    expect(String(def.text)).toContain("limit=50");

    const zero = await run({ action: "search", limit: 0 });
    expect((zero.data as { entries: StubEntry[] }).entries).toHaveLength(1);
    expect(String(zero.text)).toContain("limit=1");
    expect(String(zero.text)).toContain("Showing 1 of 5 matching entries");

    const overflow = await run({ action: "search", limit: 500 });
    expect(String(overflow.text)).toContain("limit=200");

    const newestTwo = await run({ action: "search", limit: 2.9 });
    const shown = (newestTwo.data as { entries: StubEntry[] }).entries;
    expect(shown.map((entry) => entry.message)).toEqual(["entry-3", "entry-4"]);
    expect(String(newestTwo.text)).toContain("limit=2");
    expect(String(newestTwo.text)).toContain("Showing 2 of 5 matching entries");
  });

  it("returns LOGS_SEARCH_FAILED on HTTP error", async () => {
    stubFetch({ ok: false, status: 503 });
    const result = await run({ action: "search" });
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_SEARCH_FAILED" });
    expect(result.text).toBe("Failed to load logs: HTTP 503");
  });

  it("returns LOGS_SEARCH_FAILED when fetch throws", async () => {
    stubFetch({ throw: new Error("connection refused") });
    const result = await run({ action: "search" });
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_SEARCH_FAILED" });
    expect(result.text).toBe("Failed to search logs: connection refused");
  });

  it("stringifies non-Error search throws", async () => {
    stubFetch({ throw: "boom" });
    const result = await run({ action: "search" });
    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to search logs: boom");
  });
});

describe("logsAction delete", () => {
  it("DELETEs /api/logs and reports a finite cleared count", async () => {
    stubFetch({ ok: true, body: { cleared: 12 } });
    const result = await run({ action: "delete" });
    expect(captured[0]?.method).toBe("DELETE");
    expect(captured[0]?.url).toMatch(/^http:\/\/localhost:\d+\/api\/logs$/);
    expect(result.success).toBe(true);
    expect(result.text).toBe("Cleared 12 log entries.");
    expect(result.values).toEqual({ cleared: 12 });
    expect(result.data).toMatchObject({
      actionName: "LOGS",
      op: "delete",
      cleared: 12,
    });
  });

  it("treats missing, non-finite, or non-number cleared as 0", async () => {
    stubFetch({ ok: true, body: {} });
    expect((await run({ action: "delete" })).values).toEqual({ cleared: 0 });

    stubFetch({ ok: true, body: { cleared: Number.NaN } });
    expect((await run({ action: "delete" })).values).toEqual({ cleared: 0 });

    stubFetch({ ok: true, body: { cleared: Number.POSITIVE_INFINITY } });
    expect((await run({ action: "delete" })).values).toEqual({ cleared: 0 });

    stubFetch({ ok: true, body: { cleared: "9" } });
    expect((await run({ action: "delete" })).values).toEqual({ cleared: 0 });
  });

  it("returns LOGS_DELETE_FAILED on HTTP error", async () => {
    stubFetch({ ok: false, status: 403 });
    const result = await run({ action: "delete" });
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_DELETE_FAILED" });
    expect(result.text).toBe("Failed to clear logs: HTTP 403");
  });

  it("returns LOGS_DELETE_FAILED when fetch throws", async () => {
    stubFetch({ throw: new Error("reset") });
    const result = await run({ action: "delete" });
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_DELETE_FAILED" });
    expect(result.text).toBe("Failed to delete logs: reset");
  });
});

describe("logsAction set_level", () => {
  it("rejects a missing or unknown level with the valid list", async () => {
    const missing = await run({ action: "set_level" });
    expect(missing.success).toBe(false);
    expect(missing.values).toEqual({ error: "LOGS_SET_LEVEL_FAILED" });
    expect(missing.data).toMatchObject({
      validLevels: ["trace", "debug", "info", "warn", "error"],
    });
    expect(missing.text).toContain("trace, debug, info, warn, error");

    const bad = await run({ action: "set_level", level: "fatal" });
    expect(bad.success).toBe(false);
    expect(bad.values).toEqual({ error: "LOGS_SET_LEVEL_FAILED" });
  });

  it("fails when the runtime has no override map", async () => {
    const result = await run(
      { action: "set_level", level: "debug" },
      { runtime: { agentId: "agent-1" } as unknown as IAgentRuntime },
    );
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ error: "LOGS_SET_LEVEL_FAILED" });
    expect(result.text).toContain("not supported by this runtime version");
  });

  it("stores a per-room override from the message room and confirms via callback", async () => {
    const overrides = new Map<string, string>();
    const rt = {
      agentId: "agent-1",
      logLevelOverrides: overrides,
    } as unknown as IAgentRuntime;
    const previousLevel =
      "level" in logger && typeof logger.level === "string"
        ? logger.level
        : undefined;
    const calls: unknown[] = [];
    const callback: HandlerCallback = async (content) => {
      calls.push(content);
      return [];
    };

    try {
      const result = await run(
        { action: "set_level", level: "DEBUG" },
        { runtime: rt, callback },
      );
      expect(result.success).toBe(true);
      expect(overrides.get("room-default")).toBe("debug");
      expect(result.text).toBe("Log level changed to **DEBUG** for this room.");
      expect(result.userFacingText).toBe(result.text);
      expect(result.verifiedUserFacing).toBe(true);
      expect(result.turnComplete).toBe(true);
      expect(result.values).toEqual({ level: "debug" });
      expect(result.data).toMatchObject({
        actionName: "LOGS",
        op: "set_level",
        level: "debug",
        roomId: "room-default",
      });
      expect(calls).toEqual([
        {
          text: "Log level changed to **DEBUG** for this room.",
          action: "LOGS_SET_LEVEL",
        },
      ]);
      if (previousLevel !== undefined) {
        expect((logger as typeof logger & { level: string }).level).toBe(
          "debug",
        );
      }
    } finally {
      if (previousLevel !== undefined) {
        (logger as typeof logger & { level: string }).level = previousLevel;
      }
    }
  });

  it("honors params.roomId over the message room and skips a missing callback", async () => {
    const overrides = new Map<string, string>();
    const rt = {
      agentId: "agent-1",
      logLevelOverrides: overrides,
    } as unknown as IAgentRuntime;
    const previousLevel =
      "level" in logger && typeof logger.level === "string"
        ? logger.level
        : undefined;
    try {
      const result = await run(
        { action: "set_level", level: "warn", roomId: "room-explicit" },
        { runtime: rt },
      );
      expect(result.success).toBe(true);
      expect(overrides.get("room-explicit")).toBe("warn");
      expect(overrides.has("room-default")).toBe(false);
      expect(result.data).toMatchObject({
        level: "warn",
        roomId: "room-explicit",
      });
    } finally {
      if (previousLevel !== undefined) {
        (logger as typeof logger & { level: string }).level = previousLevel;
      }
    }
  });
});
