/**
 * Unit tests for the services/handoff public barrel (`./index.ts`).
 *
 * Every runtime export is exercised through the public entry point rather than
 * the private modules: service resolution keyed by HANDOFF_SERVICE, store
 * input validation and corrupt-cache handling, and the pure resume-evaluation
 * branches consumed by the room-policy provider. The harness is deterministic
 * — the runtime cache is an in-memory Map behind spies, no SQL, no timers.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { HandoffStatus, ResumeEvaluationInput } from "./index.ts";
import {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  HANDOFF_SERVICE,
  HandoffService,
  resolveHandoffService,
} from "./index.ts";

function makeRuntime() {
  const cache = new Map<string, unknown>();
  const getCache = vi.fn(async (key: string): Promise<unknown> => {
    return cache.get(key) ?? null;
  });
  const setCache = vi.fn(
    async (key: string, value: unknown): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
  );
  const deleteCache = vi.fn(async (key: string): Promise<boolean> => {
    return cache.delete(key);
  });
  const getService = vi.fn((_serviceType: string): unknown => null);
  const runtime = {
    agentId: "test-agent",
    getCache,
    setCache,
    deleteCache,
    getService,
  } as unknown as IAgentRuntime;
  return { cache, runtime, getCache, setCache, deleteCache, getService };
}

describe("services/handoff public barrel", () => {
  it("resolves a registered HandoffService by the HANDOFF_SERVICE key", async () => {
    const { runtime, getService } = makeRuntime();
    const service = await HandoffService.start(runtime);
    getService.mockImplementation(() => service);

    const resolved = resolveHandoffService(runtime);
    expect(resolved).toBe(service);
    expect(getService).toHaveBeenCalledWith(HANDOFF_SERVICE);

    // The resolved service hands out a working store.
    const store = resolved?.getStore();
    expect(store).toBeDefined();
    await store?.enter("room-resolve", {
      reason: "resolved through the barrel",
      resumeOn: { kind: "mention" },
    });
    expect((await store?.status("room-resolve"))?.active).toBe(true);
    await store?.exit("room-resolve");
    expect((await store?.status("room-resolve"))?.active).toBe(false);
  });

  it("rejects invalid enter input before touching the cache", async () => {
    const { runtime, setCache } = makeRuntime();
    const store = createHandoffStore(runtime);

    await expect(
      store.enter("", { reason: "r", resumeOn: { kind: "mention" } }),
    ).rejects.toThrow(/roomId is required/);

    await expect(
      store.enter("room-bad", {
        reason: "r",
        resumeOn: { kind: "nope" } as never,
      }),
    ).rejects.toThrow(/invalid resumeOn/);

    await expect(
      store.enter("room-bad", {
        reason: "r",
        resumeOn: { kind: "silence_minutes", minutes: 0 },
      }),
    ).rejects.toThrow(/invalid resumeOn/);

    await expect(
      store.enter("room-bad", {
        reason: "r",
        resumeOn: { kind: "user_request_help", userId: "" },
      }),
    ).rejects.toThrow(/invalid resumeOn/);

    await expect(
      store.enter("room-bad", {
        reason: "   ",
        resumeOn: { kind: "mention" },
      }),
    ).rejects.toThrow(/reason is required/);

    expect(setCache).not.toHaveBeenCalled();
  });

  it("trims the reason and replaces lone surrogates before storing it", async () => {
    const { runtime } = makeRuntime();
    const store = createHandoffStore(runtime);

    await store.enter("room-normalize", {
      reason: "  handing off \ud800  ",
      resumeOn: { kind: "mention" },
    });
    const status = await store.status("room-normalize");
    expect(status.active).toBe(true);
    // Outer whitespace trimmed; the unpaired surrogate became U+FFFD.
    expect(status.reason).toBe("handing off \uFFFD");
  });

  it("treats empty room ids as inactive without reading or writing the cache", async () => {
    const { runtime, getCache, deleteCache } = makeRuntime();
    const store = createHandoffStore(runtime);

    expect(await store.exit("")).toBeUndefined();
    expect(deleteCache).not.toHaveBeenCalled();

    expect(await store.status("")).toEqual({ active: false });
    expect(getCache).not.toHaveBeenCalled();

    expect(await store.status("never-entered")).toEqual({ active: false });
    expect(getCache).toHaveBeenCalledWith(
      `${"eliza:lifeops:handoff:v1:"}never-entered`,
    );
  });

  it("reports inactive when the cached record fails validation, active again when it is valid", async () => {
    const { cache, runtime, setCache } = makeRuntime();
    const store = createHandoffStore(runtime);

    await store.enter("room-corrupt", {
      reason: "valid entry",
      resumeOn: { kind: "mention" },
    });
    const key = setCache.mock.calls[0]?.[0] ?? "";
    const validRecord = setCache.mock.calls[0]?.[1];
    expect(await store.status("room-corrupt")).toMatchObject({
      active: true,
      reason: "valid entry",
    });

    const corruptRecords: unknown[] = [
      {
        roomId: "",
        enteredAt: new Date().toISOString(),
        reason: "r",
        resumeOn: { kind: "mention" },
      },
      {
        roomId: "room-corrupt",
        enteredAt: "not-a-date",
        reason: "r",
        resumeOn: { kind: "mention" },
      },
      {
        roomId: "room-corrupt",
        enteredAt: new Date().toISOString(),
        reason: null,
        resumeOn: { kind: "mention" },
      },
      {
        roomId: "room-corrupt",
        enteredAt: new Date().toISOString(),
        reason: "r",
        resumeOn: { kind: "silence_minutes", minutes: -1 },
      },
      {
        roomId: "room-corrupt",
        enteredAt: new Date().toISOString(),
        reason: "r",
        resumeOn: { kind: "bogus" },
      },
    ];
    for (const record of corruptRecords) {
      cache.set(key, record);
      expect(await store.status("room-corrupt")).toEqual({ active: false });
    }

    cache.set(key, validRecord);
    expect((await store.status("room-corrupt")).active).toBe(true);
  });

  it("never auto-resumes an explicit_resume condition on any inbound signal", () => {
    const evaluation = evaluateResume({
      status: { active: true, resumeOn: { kind: "explicit_resume" } },
      mentionsAgent: true,
      userRequestedHelp: true,
      requestingUserId: "user-1",
    });
    expect(evaluation.shouldResume).toBe(false);
    expect(evaluation.reason).toBeUndefined();
  });

  it("fires silence_minutes only at or past the threshold with a parsable last message", () => {
    const lastMessageIso = "2026-01-01T00:00:00.000Z";
    const base: ResumeEvaluationInput = {
      status: {
        active: true,
        resumeOn: { kind: "silence_minutes", minutes: 5 },
      },
      lastMessageIso,
    };

    const atThreshold = evaluateResume({
      ...base,
      nowIso: "2026-01-01T00:05:00.000Z",
    });
    expect(atThreshold.shouldResume).toBe(true);
    expect(atThreshold.reason).toBe("silence ≥ 5m");

    const justUnder = evaluateResume({
      ...base,
      nowIso: "2026-01-01T00:04:59.999Z",
    });
    expect(justUnder.shouldResume).toBe(false);

    const beforeLast = evaluateResume({
      ...base,
      nowIso: "2025-12-31T23:00:00.000Z",
    });
    expect(beforeLast.shouldResume).toBe(false);

    const missingLast = evaluateResume({
      status: base.status,
      nowIso: "2026-01-01T01:00:00.000Z",
    });
    expect(missingLast.shouldResume).toBe(false);

    const unparsableLast = evaluateResume({
      ...base,
      lastMessageIso: "not-a-date",
      nowIso: "2026-01-01T01:00:00.000Z",
    });
    expect(unparsableLast.shouldResume).toBe(false);
  });

  it("resumes user_request_help only for the flagged matching requester", () => {
    const status: HandoffStatus = {
      active: true,
      resumeOn: { kind: "user_request_help", userId: "user-42" },
    };

    const matched = evaluateResume({
      status,
      requestingUserId: "user-42",
      userRequestedHelp: true,
    });
    expect(matched.shouldResume).toBe(true);
    expect(matched.reason).toBe("user requested help");

    const wrongUser = evaluateResume({
      status,
      requestingUserId: "user-other",
      userRequestedHelp: true,
    });
    expect(wrongUser.shouldResume).toBe(false);

    const unflagged = evaluateResume({
      status,
      requestingUserId: "user-42",
      userRequestedHelp: false,
    });
    expect(unflagged.shouldResume).toBe(false);
  });

  it("resumes a mention condition only while the handoff is active", () => {
    const activeMention = evaluateResume({
      status: { active: true, resumeOn: { kind: "mention" } },
      mentionsAgent: true,
    });
    expect(activeMention).toEqual({ shouldResume: true, reason: "mentioned" });

    const noMention = evaluateResume({
      status: { active: true, resumeOn: { kind: "mention" } },
    });
    expect(noMention.shouldResume).toBe(false);

    const inactiveRoom = evaluateResume({
      status: { active: false },
      mentionsAgent: true,
    });
    expect(inactiveRoom.shouldResume).toBe(false);
  });

  it("renders each condition to a phrase carrying its parameters", () => {
    expect(typeof describeResumeCondition({ kind: "mention" })).toBe("string");
    expect(describeResumeCondition({ kind: "mention" }).length).toBeGreaterThan(
      0,
    );

    const singular = describeResumeCondition({
      kind: "silence_minutes",
      minutes: 1,
    });
    const plural = describeResumeCondition({
      kind: "silence_minutes",
      minutes: 2,
    });
    expect(singular).toContain("1");
    expect(plural).toContain("2");
    expect(singular).not.toBe(plural);

    const helpPhrase = describeResumeCondition({
      kind: "user_request_help",
      userId: "alice",
    });
    expect(helpPhrase).toContain("alice");
  });
});
