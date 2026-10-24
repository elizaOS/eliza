/**
 * A scheduled draft send fires when its time is reached, and a time that is
 * already past is reached on the next scheduler tick. A misread sendAt
 * (epoch seconds, a bare year, a blank) must be refused instead of handed to
 * the scheduler, or "send later" sends at once while the action reports
 * "Scheduled". Real scheduleDraftSendAction handler; the triage service's
 * draft lookup and scheduler call are stubbed.
 */
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { scheduleDraftSendAction } from "../actions/scheduleDraftSend.ts";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "../triage-service.ts";
import { createFakeRuntime, FAKE_AGENT_ID } from "./fake-runtime.ts";

afterEach(() => {
  vi.restoreAllMocks();
  __resetDefaultTriageServiceForTests();
});

function cacheRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return Object.assign(createFakeRuntime(), {
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    compareAndSetCache: async (
      key: string,
      expected: unknown,
      next: unknown,
    ) => {
      if (JSON.stringify(cache.get(key)) !== JSON.stringify(expected))
        return false;
      cache.set(key, next);
      return true;
    },
  }) as IAgentRuntime;
}

let clock = Date.now();
function ownerTurn(text: string): Memory {
  clock += 1_000;
  return {
    id: `00000000-0000-4000-8000-${String(clock).padStart(12, "0").slice(-12)}` as UUID,
    entityId: "00000000-0000-4000-8000-00000000000a" as UUID,
    roomId: "00000000-0000-4000-8000-00000000000b" as UUID,
    agentId: FAKE_AGENT_ID,
    content: { text, source: "test" },
    createdAt: clock,
  } as Memory;
}

async function scheduleAs(
  runtime: IAgentRuntime,
  message: Memory,
  sendAt: unknown,
) {
  return scheduleDraftSendAction.handler(runtime, message, undefined, {
    parameters: { draftId: "d1", sendAt },
  } as unknown as HandlerOptions);
}

function stubService() {
  const service = getDefaultTriageService();
  vi.spyOn(service, "getDraft").mockReturnValue({
    draftId: "d1",
    agentId: FAKE_AGENT_ID,
    source: "gmail",
    to: [{ identifier: "alice@example.com" }],
    subject: "Later",
    body: "Sent later.",
    preview: "To alice@example.com: Later",
    metadata: {},
  } as never);
  return vi.spyOn(service, "scheduleDraftSend").mockResolvedValue({
    draftId: "d1",
    scheduleCommit: {
      kind: "scheduled_task",
      id: "t1",
      idempotencyKey: "k1",
      replayed: false,
      committedAt: new Date().toISOString(),
    },
  } as never);
}

async function schedule(runtime: IAgentRuntime, sendAt: unknown) {
  return scheduleDraftSendAction.handler(runtime, {} as Memory, undefined, {
    parameters: { draftId: "d1", sendAt },
  } as unknown as HandlerOptions);
}

it.each([
  ["epoch seconds", "1760716800"],
  ["a bare year", "2026"],
  ["a blank", " "],
  ["a past ISO time", "2020-01-01T09:00:00Z"],
])("refuses %s instead of sending the draft at once", async (_case, sendAt) => {
  const scheduled = stubService();
  const result = await schedule(createFakeRuntime(), sendAt);
  expect(result?.success).toBe(false);
  expect(result?.text).toMatch(/must be in the future/);
  expect(scheduled).not.toHaveBeenCalled();
});

it("schedules a future time once the owner confirms", async () => {
  const scheduled = stubService();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const runtime = cacheRuntime();
  const asked = await scheduleAs(runtime, ownerTurn("send it later"), future);
  expect(asked?.data).toMatchObject({ requiresConfirmation: true });
  expect(scheduled).not.toHaveBeenCalled();
  const result = await scheduleAs(runtime, ownerTurn("yes"), future);
  expect(result?.success).toBe(true);
  expect(scheduled).toHaveBeenCalledWith(
    expect.anything(),
    "d1",
    Date.parse(future),
  );
});
