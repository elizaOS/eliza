/**
 * Route-level e2e for the inbox HTTP surface against a REAL runtime.
 *
 * Unlike `inbox-routes.test.ts` (pure auth-gate unit with the service
 * mocked out), this suite registers the REAL `inboxPlugin` on a REAL
 * PGLite-backed AgentRuntime and drives the registered route handlers the
 * way app-core's HTTP adapter does: `runtime.routes` lookup + a
 * RouteHandlerContext. The InboxService / InboxRepository / migration
 * service / `app_inbox` tables are all real; only the TEXT_SMALL model is a
 * deterministic handler (the LLM boundary).
 *
 * Also asserts the #8652 registration contract: loading plugin-inbox
 * standalone (without plugin-personal-assistant) registers the INBOX
 * umbrella AND its promoted INBOX_* virtual actions, plus both providers.
 */

import {
  type AgentRuntime,
  ModelType,
  type ModelTypeName,
  type RouteHandlerContext,
  type RouteHandlerResult,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import { InboxRepository } from "../src/inbox/repository.ts";
import type { InboundMessage, TriageEntry } from "../src/inbox/types.ts";
import { inboxPlugin } from "../src/plugin.ts";

/** Deterministic TEXT_SMALL classifier (same contract the triage prompt uses). */
function deterministicTriageModel(prompt: string): string {
  const texts = prompt
    .split("\n")
    .filter((line) => line.trim().startsWith("text:"))
    .map((line) => line.slice(line.indexOf("text:") + "text:".length).trim());
  const results = texts.map((text) => {
    const lower = text.toLowerCase();
    if (lower.includes("urgent") || lower.includes("asap")) {
      return {
        classification: "urgent",
        urgency: "high",
        confidence: 0.95,
        reasoning: "Contains urgency keyword.",
        suggestedResponse: "On it — will handle right away.",
      };
    }
    if (lower.includes("?") || lower.includes("can you")) {
      return {
        classification: "needs_reply",
        urgency: "medium",
        confidence: 0.8,
        reasoning: "Question expecting a response.",
        suggestedResponse: null,
      };
    }
    if (lower.includes("newsletter") || lower.includes("unsubscribe")) {
      return {
        classification: "ignore",
        urgency: "low",
        confidence: 0.9,
        reasoning: "Automated newsletter.",
        suggestedResponse: null,
      };
    }
    return {
      classification: "info",
      urgency: "low",
      confidence: 0.7,
      reasoning: "Informational.",
      suggestedResponse: null,
    };
  });
  return JSON.stringify({ results });
}

function inbound(
  overrides: Partial<InboundMessage> & { id: string; text: string },
): InboundMessage {
  return {
    source: "discord",
    senderName: "Route Sender",
    channelName: "general",
    channelType: "dm",
    snippet: overrides.text.slice(0, 80),
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("inbox routes e2e — real plugin on real PGLite runtime", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let repo: InboxRepository;

  /** Dispatch a request through the runtime-registered route handlers. */
  async function call(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown;
      params?: Record<string, string>;
      query?: Record<string, string | string[]>;
      trusted?: boolean;
    } = {},
  ): Promise<RouteHandlerResult> {
    // Match the registered route by method + path pattern (`:id` segment).
    const route = runtime.routes.find((candidate) => {
      if (candidate.type !== method) return false;
      const pattern = new RegExp(
        `^${candidate.path.replace(/:[^/]+/g, "[^/]+")}$`,
      );
      return pattern.test(path);
    });
    expect(
      route?.routeHandler,
      `route ${method} ${path} must be registered on the runtime`,
    ).toBeDefined();
    const ctx: RouteHandlerContext = {
      body: opts.body,
      params: opts.params ?? {},
      query: opts.query ?? {},
      headers: {},
      method,
      path,
      runtime,
      inProcess: false,
      isTrustedLocal: opts.trusted !== false,
    };
    const result = await route?.routeHandler?.(ctx);
    if (!result) throw new Error(`route ${method} ${path} returned nothing`);
    return result;
  }

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "inbox-routes-e2e",
      // The REAL plugin: schema + migration service + promoted actions +
      // providers + routes. No PA in the runtime — standalone mode.
      plugins: [inboxPlugin],
    });
    runtime = testResult.runtime;
    runtime.registerModel(
      ModelType.TEXT_SMALL as ModelTypeName,
      async (_rt, params) =>
        deterministicTriageModel(
          String((params as { prompt?: string }).prompt),
        ),
      "inbox-routes-e2e",
      100,
    );
    repo = new InboxRepository(runtime);
  }, 120_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("standalone plugin-inbox registers INBOX plus the promoted INBOX_* virtuals and both providers", () => {
    const actionNames = new Set(runtime.actions.map((action) => action.name));
    expect(actionNames.has("INBOX")).toBe(true);
    // The promoted virtuals must exist WITHOUT plugin-personal-assistant in
    // the runtime (pre-port they were only registered by PA's action array).
    for (const virtual of [
      "INBOX_LIST",
      "INBOX_TRIAGE",
      "INBOX_REPLY",
      "INBOX_SNOOZE",
      "INBOX_ARCHIVE",
      "INBOX_APPROVE",
    ]) {
      expect(actionNames.has(virtual), `${virtual} registered`).toBe(true);
    }
    const providerNames = new Set(
      runtime.providers.map((provider) => provider.name),
    );
    expect(providerNames.has("inboxTriage")).toBe(true);
    expect(providerNames.has("inboxCrossChannelContext")).toBe(true);
  });

  it("rejects every inbox route for non-trusted callers", async () => {
    for (const [method, path] of [
      ["GET", "/api/lifeops/inbox/triage"],
      ["POST", "/api/lifeops/inbox/triage"],
      ["POST", "/api/lifeops/inbox/some-id/reply"],
      ["POST", "/api/lifeops/inbox/some-id/snooze"],
      ["POST", "/api/lifeops/inbox/some-id/archive"],
      ["POST", "/api/lifeops/inbox/some-id/approve"],
    ] as const) {
      const result = await call(method, path, { trusted: false });
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(result.body).toEqual({
        ok: false,
        error: "Inbox routes are owner-only",
      });
    }
  });

  it("GET triage returns an empty queue before any triage run", async () => {
    const result = await call("GET", "/api/lifeops/inbox/triage");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, entries: [] });
  });

  it("POST triage rejects a body without a messages array", async () => {
    for (const body of [undefined, {}, { messages: "nope" }, []]) {
      const result = await call("POST", "/api/lifeops/inbox/triage", { body });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        ok: false,
        error: "messages array is required",
      });
    }
  });

  it("POST triage classifies through the real service and persists real app_inbox rows", async () => {
    const result = await call("POST", "/api/lifeops/inbox/triage", {
      body: {
        messages: [
          inbound({
            id: "route-msg-urgent",
            text: "URGENT: prod is down, need eyes asap",
          }),
          inbound({
            id: "route-msg-question",
            text: "Can you review my PR when you get a chance?",
          }),
          inbound({
            id: "route-msg-newsletter",
            text: "Your weekly newsletter digest",
          }),
        ],
      },
    });
    expect(result.status).toBe(200);
    const body = result.body as {
      ok: boolean;
      triaged: Array<{ classification: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.triaged.map((item) => item.classification)).toEqual([
      "urgent",
      "needs_reply",
      "ignore",
    ]);

    // Domain artifact: the rows really landed in app_inbox tables.
    const unresolved = await repo.getUnresolved({ limit: 50 });
    const bySource = new Map(
      unresolved.map((entry) => [entry.sourceMessageId, entry]),
    );
    expect(bySource.get("route-msg-urgent")?.classification).toBe("urgent");
    expect(bySource.get("route-msg-urgent")?.suggestedResponse).toBe(
      "On it — will handle right away.",
    );
    expect(bySource.get("route-msg-question")?.classification).toBe(
      "needs_reply",
    );
    // "ignore" rows persist too (resolved = FALSE until acted on) and sort
    // after the higher-urgency entries.
    expect(bySource.get("route-msg-newsletter")?.classification).toBe("ignore");
    expect(unresolved[unresolved.length - 1]?.sourceMessageId).toBe(
      "route-msg-newsletter",
    );
  });

  it("GET triage filters by classification and respects limit", async () => {
    const urgent = await call("GET", "/api/lifeops/inbox/triage", {
      query: { classification: "urgent" },
    });
    expect(urgent.status).toBe(200);
    const urgentEntries = (urgent.body as { entries: TriageEntry[] }).entries;
    expect(urgentEntries.length).toBeGreaterThanOrEqual(1);
    for (const entry of urgentEntries) {
      expect(entry.classification).toBe("urgent");
    }

    const limited = await call("GET", "/api/lifeops/inbox/triage", {
      query: { limit: "1" },
    });
    expect((limited.body as { entries: TriageEntry[] }).entries).toHaveLength(
      1,
    );

    // An unknown classification value falls back to the unresolved queue
    // rather than erroring or leaking a raw SQL failure.
    const bogus = await call("GET", "/api/lifeops/inbox/triage", {
      query: { classification: "banana" },
    });
    expect(bogus.status).toBe(200);
    expect(
      (bogus.body as { entries: TriageEntry[] }).entries.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("POST :id/snooze hides the entry until the timestamp; includeSnoozed reveals it", async () => {
    const unresolved = await repo.getUnresolved({ limit: 50 });
    const target = unresolved.find(
      (entry) => entry.sourceMessageId === "route-msg-question",
    );
    expect(target).toBeDefined();
    if (!target) throw new Error("unreachable");

    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const snooze = await call(
      "POST",
      `/api/lifeops/inbox/${target.id}/snooze`,
      { params: { id: target.id }, body: { snoozedUntil: until } },
    );
    expect(snooze.status).toBe(200);
    expect(snooze.body).toMatchObject({
      ok: true,
      subaction: "snooze",
      entryId: target.id,
      snoozedUntil: until,
    });

    const defaultRead = await call("GET", "/api/lifeops/inbox/triage");
    const defaultIds = (
      defaultRead.body as { entries: TriageEntry[] }
    ).entries.map((entry) => entry.id);
    expect(defaultIds).not.toContain(target.id);

    const withSnoozed = await call("GET", "/api/lifeops/inbox/triage", {
      query: { includeSnoozed: "1" },
    });
    const snoozedIds = (
      withSnoozed.body as { entries: TriageEntry[] }
    ).entries.map((entry) => entry.id);
    expect(snoozedIds).toContain(target.id);
  });

  it("snooze validates its inputs: unknown entry and bad timestamp both fail loudly", async () => {
    const missing = await call(
      "POST",
      "/api/lifeops/inbox/00000000-0000-0000-0000-000000000000/snooze",
      {
        params: { id: "00000000-0000-0000-0000-000000000000" },
        body: { snoozedUntil: new Date(Date.now() + 1000).toISOString() },
      },
    );
    expect(missing.status).toBe(400);
    expect(String((missing.body as { error: string }).error)).toContain(
      "was not found",
    );

    const unresolved = await repo.getUnresolved({ limit: 1 });
    const anyEntry = unresolved[0];
    expect(anyEntry).toBeDefined();
    if (!anyEntry) throw new Error("unreachable");
    const badTs = await call(
      "POST",
      `/api/lifeops/inbox/${anyEntry.id}/snooze`,
      { params: { id: anyEntry.id }, body: { snoozedUntil: "not-a-date" } },
    );
    expect(badTs.status).toBe(400);
    expect(String((badTs.body as { error: string }).error)).toContain(
      "snooze timestamp",
    );
  });

  it("POST :id/approve fails cleanly when the entry has no draft or suggested response", async () => {
    const unresolved = await repo.getUnresolved({
      limit: 50,
      includeSnoozed: true,
    });
    const noDraft = unresolved.find(
      (entry) => !entry.draftResponse && !entry.suggestedResponse,
    );
    expect(noDraft).toBeDefined();
    if (!noDraft) throw new Error("unreachable");

    const approve = await call(
      "POST",
      `/api/lifeops/inbox/${noDraft.id}/approve`,
      { params: { id: noDraft.id }, body: {} },
    );
    expect(approve.status).toBe(400);
    expect(String((approve.body as { error: string }).error)).toContain(
      "no draft or suggested response",
    );
  });

  it("POST :id/reply requires a body and a real entry", async () => {
    const noEntry = await call(
      "POST",
      "/api/lifeops/inbox/11111111-1111-1111-1111-111111111111/reply",
      {
        params: { id: "11111111-1111-1111-1111-111111111111" },
        body: { body: "hello" },
      },
    );
    expect(noEntry.status).toBe(400);

    const unresolved = await repo.getUnresolved({
      limit: 1,
      includeSnoozed: true,
    });
    const entry = unresolved[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("unreachable");
    const noBody = await call("POST", `/api/lifeops/inbox/${entry.id}/reply`, {
      params: { id: entry.id },
      body: {},
    });
    expect(noBody.status).toBe(400);
    expect(String((noBody.body as { error: string }).error)).toContain(
      "reply body is required",
    );
  });

  it("re-triaging the same source message ids dedupes instead of duplicating rows", async () => {
    const before = await repo.getUnresolved({ limit: 50 });
    const result = await call("POST", "/api/lifeops/inbox/triage", {
      body: {
        messages: [
          inbound({
            id: "route-msg-urgent",
            text: "URGENT: prod is down, need eyes asap",
          }),
        ],
      },
    });
    expect(result.status).toBe(200);
    const after = await repo.getUnresolved({ limit: 50 });
    expect(
      after.filter((entry) => entry.sourceMessageId === "route-msg-urgent"),
    ).toHaveLength(1);
    expect(after.length).toBe(before.length);
  });
});
