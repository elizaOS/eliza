/**
 * Scheduling a draft is a send: it must pass the same owner consent gate as
 * sending it now. Real scheduleDraftSendAction handler and real send-consent
 * helper over a cache-backed runtime; the triage service's draft lookup and
 * scheduler call are stubbed.
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
  const base = createFakeRuntime();
  const cache = new Map<string, unknown>();
  return Object.assign(base, {
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

const draft = {
  draftId: "d1",
  agentId: FAKE_AGENT_ID,
  source: "gmail",
  to: [{ identifier: "alice@example.com" }],
  subject: "Q3 numbers",
  body: "Attached.",
  preview: "To alice@example.com: Q3 numbers",
  metadata: {},
};

function stubService() {
  const service = getDefaultTriageService();
  vi.spyOn(service, "getDraft").mockReturnValue(draft as never);
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

let clock = Date.now();
function ownerTurn(text: string): Memory {
  clock += 1_000;
  return {
    id: `00000000-0000-0000-0000-${String(clock).slice(-12)}` as UUID,
    entityId: "00000000-0000-0000-0000-00000000owner" as UUID,
    roomId: "00000000-0000-0000-0000-000000000room" as UUID,
    agentId: FAKE_AGENT_ID,
    content: { text, source: "test" },
    createdAt: clock,
  } as Memory;
}

async function schedule(runtime: IAgentRuntime, message: Memory) {
  const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return scheduleDraftSendAction.handler(runtime, message, undefined, {
    parameters: { draftId: "d1", sendAt },
  } as unknown as HandlerOptions);
}

it("asks for consent before scheduling and schedules on a later yes", async () => {
  const scheduled = stubService();
  const runtime = cacheRuntime();
  const first = await schedule(runtime, ownerTurn("send it to alice tomorrow"));
  expect(scheduled).not.toHaveBeenCalled();
  expect(first?.data).toMatchObject({
    requiresConfirmation: true,
    draftId: "d1",
  });
  const second = await schedule(runtime, ownerTurn("yes"));
  expect(second?.success).toBe(true);
  expect(scheduled).toHaveBeenCalledTimes(1);
});

it("does not schedule when the owner declines", async () => {
  const scheduled = stubService();
  const runtime = cacheRuntime();
  await schedule(runtime, ownerTurn("schedule it"));
  const declined = await schedule(runtime, ownerTurn("no"));
  expect(declined?.success).toBe(false);
  expect(scheduled).not.toHaveBeenCalled();
});
