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
import { registerSendPolicy } from "../send-policy.ts";
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
    id: `00000000-0000-4000-8000-${String(clock).padStart(12, "0").slice(-12)}` as UUID,
    entityId: "00000000-0000-4000-8000-00000000000a" as UUID,
    roomId: "00000000-0000-4000-8000-00000000000b" as UUID,
    agentId: FAKE_AGENT_ID,
    content: { text, source: "test" },
    createdAt: clock,
  } as Memory;
}

const SEND_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const LATER = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

async function schedule(
  runtime: IAgentRuntime,
  message: Memory,
  sendAt: string = SEND_AT,
) {
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

it("re-asks when the confirming turn names a different send time", async () => {
  const scheduled = stubService();
  const runtime = cacheRuntime();
  await schedule(runtime, ownerTurn("send it in an hour"), SEND_AT);
  const confirmed = await schedule(runtime, ownerTurn("yes"), LATER);
  expect(confirmed?.data).toMatchObject({ requiresConfirmation: true });
  expect(scheduled).not.toHaveBeenCalled();
});

it("re-asks when the draft changed between the ask and the yes", async () => {
  const scheduled = stubService();
  const runtime = cacheRuntime();
  await schedule(runtime, ownerTurn("send it later"));
  vi.spyOn(getDefaultTriageService(), "getDraft").mockReturnValue({
    ...draft,
    body: "Attached, plus the revised forecast.",
  } as never);
  const confirmed = await schedule(runtime, ownerTurn("yes"));
  expect(confirmed?.data).toMatchObject({ requiresConfirmation: true });
  expect(scheduled).not.toHaveBeenCalled();
});

it("refuses before asking when the connector needs owner approval", async () => {
  const scheduled = stubService();
  const runtime = cacheRuntime();
  registerSendPolicy(runtime, {
    shouldRequireApproval: async () => true,
    enqueueApproval: async () => {
      throw new Error("not reached");
    },
  } as never);
  const result = await schedule(runtime, ownerTurn("send it later"));
  expect(result?.success).toBe(false);
  expect(result?.text).toMatch(/send_draft/);
  expect(result?.data).toBeUndefined();
  expect(scheduled).not.toHaveBeenCalled();
});
