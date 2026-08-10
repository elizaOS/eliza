/**
 * Spend-guard tests for TASKMARKET_CREATE_TASK — the only action here that
 * moves money. Each guard is asserted independently, plus the refuse-don't-trim
 * behaviour on an over-budget reward, the two-turn confirmation bound to the
 * real user message, the atomic-precision floor, the 2xx-negative creation
 * response, and the fact that no guard failure ever reaches the network.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskMarketBrowseAction } from "./actions/browse.ts";
import { taskMarketCreateTaskAction } from "./actions/create-task.ts";
import { taskMarketStatusAction } from "./actions/status.ts";
import {
  atomicToUsdc,
  resolveTaskMarketConfig,
  usdcToAtomic,
} from "./types.ts";

/**
 * Runtime double with the cache the core confirmation gate stores pending
 * previews in. Without a real cache the gate can never reach its second turn,
 * so every creation test would trivially stop at "pending".
 */
function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    getSetting: (name: string) => settings[name],
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
  } as unknown as IAgentRuntime;
}

const CONFIGURED = {
  TASKMARKET_API_TOKEN: "test-token",
  TASKMARKET_ADDRESS: "0x0000000000000000000000000000000000000001",
};

const ENABLED = { ...CONFIGURED, TASKMARKET_ALLOW_TASK_CREATION: "true" };

/** A real Memory carrying the sender identity the confirmation gate binds to. */
function userMessage(text: string, entityId = "user-1"): Memory {
  return {
    entityId,
    content: { text, source: "test" },
  } as unknown as Memory;
}

const message = userMessage("post that task");

const VALID_BRIEF = "Write a 500-word summary of the attached research paper.";

/**
 * Drive the action to the point where the user has approved: first call stashes
 * the preview and returns pending, the reply turn resolves it.
 */
async function createWithConfirmation(
  runtime: IAgentRuntime,
  options: Record<string, unknown>,
  reply = "yes",
  entityId = "user-1",
) {
  const preview = await taskMarketCreateTaskAction.handler(
    runtime,
    userMessage("post that task", entityId),
    undefined,
    options,
  );
  const settled = await taskMarketCreateTaskAction.handler(
    runtime,
    userMessage(reply, entityId),
    undefined,
    options,
  );
  return { preview, settled };
}

describe("resolveTaskMarketConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is undefined without both credentials", () => {
    expect(resolveTaskMarketConfig(makeRuntime({}))).toBeUndefined();
    expect(
      resolveTaskMarketConfig(makeRuntime({ TASKMARKET_API_TOKEN: "t" })),
    ).toBeUndefined();
    expect(
      resolveTaskMarketConfig(makeRuntime({ TASKMARKET_ADDRESS: "0xabc" })),
    ).toBeUndefined();
  });

  it("defaults to read-only with a 1 USDC ceiling", () => {
    const config = resolveTaskMarketConfig(makeRuntime(CONFIGURED));
    expect(config?.allowTaskCreation).toBe(false);
    expect(config?.maxTaskRewardUsdc).toBe(1);
    expect(config?.apiUrl).toBe("https://api.taskmarket.dev/api");
  });

  it("clamps a configured ceiling to the absolute maximum", () => {
    const config = resolveTaskMarketConfig(
      makeRuntime({
        ...CONFIGURED,
        TASKMARKET_MAX_TASK_REWARD_USDC: "100000",
      }),
    );
    expect(config?.maxTaskRewardUsdc).toBe(50);
  });
});

describe("atomic USDC conversion", () => {
  it("round-trips whole USDC through atomic units", () => {
    expect(usdcToAtomic(5)).toBe("5000000");
    expect(usdcToAtomic(0.5)).toBe("500000");
    expect(atomicToUsdc("5000000")).toBe(5);
  });

  it("refuses a reward that would serialize to zero atomic units", () => {
    // The old `Math.round` path turned these into "0" while the caller still
    // reported the requested amount as escrowed.
    expect(usdcToAtomic(0.0000001)).toBeUndefined();
    expect(usdcToAtomic(0.0000004)).toBeUndefined();
    expect(usdcToAtomic(0)).toBeUndefined();
    expect(usdcToAtomic(-1)).toBeUndefined();
    expect(usdcToAtomic(Number.NaN)).toBeUndefined();
    // One atomic unit is the floor, and it survives.
    expect(usdcToAtomic(0.000001)).toBe("1");
  });

  it("reports an unreadable amount as unavailable, never as zero", () => {
    expect(atomicToUsdc(undefined)).toBeUndefined();
    expect(atomicToUsdc(null)).toBeUndefined();
    expect(atomicToUsdc("")).toBeUndefined();
    expect(atomicToUsdc("not-a-number")).toBeUndefined();
    expect(atomicToUsdc(Number.NaN)).toBeUndefined();
    expect(atomicToUsdc("0")).toBe(0);
  });
});

describe("TASKMARKET_CREATE_TASK spend guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("guard 1: the action is owner-gated", () => {
    // A member or guest in a shared agent must not reach a spend path at all,
    // which is what the three config/planner-level guards cannot express.
    expect(taskMarketCreateTaskAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("guard 1: no planner-authored confirmation parameter exists", () => {
    // An LLM-set boolean must never authorize a spend; confirmation comes from
    // the user's own follow-up message instead.
    const names = (taskMarketCreateTaskAction.parameters ?? []).map(
      (parameter) => parameter.name,
    );
    expect(names).not.toContain("userConfirmed");
    expect(names).not.toContain("confirmed");
  });

  it("guard 2: validate() hides the action when creation is not enabled", async () => {
    const runtime = makeRuntime(CONFIGURED);
    await expect(
      taskMarketCreateTaskAction.validate(runtime, message),
    ).resolves.toBe(false);
    await expect(
      taskMarketCreateTaskAction.validate(makeRuntime(ENABLED), message),
    ).resolves.toBe(true);
  });

  it("guard 2: the handler refuses even if invoked directly while disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await taskMarketCreateTaskAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      {
        description: "a".repeat(50),
        rewardUsdc: 0.5,
      },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "creation_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("guard 3: refuses an over-budget reward instead of trimming it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await taskMarketCreateTaskAction.handler(
      makeRuntime({
        ...ENABLED,
        TASKMARKET_MAX_TASK_REWARD_USDC: "1",
      }),
      message,
      undefined,
      {
        description: "a".repeat(50),
        rewardUsdc: 25,
      },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      reason: "over_budget",
      requestedUsdc: 25,
      maxTaskRewardUsdc: 1,
    });
    // The critical assertion: no reduced-reward task was created either.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a too-short description before spending", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await taskMarketCreateTaskAction.handler(
      makeRuntime(ENABLED),
      message,
      undefined,
      { description: "too short", rewardUsdc: 0.5 },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "missing_param" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("guard 4: the first turn only previews — nothing is posted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await taskMarketCreateTaskAction.handler(
      makeRuntime(ENABLED),
      message,
      undefined,
      { description: VALID_BRIEF, rewardUsdc: 0.5 },
    );
    expect(result?.data).toMatchObject({
      requiresConfirmation: true,
      awaitingUserInput: true,
    });
    expect(result?.text).toContain("0.5 USDC");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("guard 4: a non-yes reply cancels without spending", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { settled } = await createWithConfirmation(
      makeRuntime(ENABLED),
      { description: VALID_BRIEF, rewardUsdc: 0.5 },
      "no, drop it",
    );
    expect(settled?.success).toBe(false);
    expect(settled?.data).toMatchObject({ reason: "cancelled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("guard 4: an approval for one task cannot settle a different one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = makeRuntime(ENABLED);
    // User is shown one brief...
    await taskMarketCreateTaskAction.handler(runtime, message, undefined, {
      description: VALID_BRIEF,
      rewardUsdc: 0.5,
    });
    // ...and the confirmed turn arrives carrying a different amount.
    const drifted = await taskMarketCreateTaskAction.handler(
      runtime,
      userMessage("yes"),
      undefined,
      { description: VALID_BRIEF, rewardUsdc: 0.9 },
    );
    // The drifted spend starts its own preview instead of settling silently.
    expect(drifted?.data).toMatchObject({ requiresConfirmation: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("guard 4: another user's yes cannot settle this user's pending spend", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = makeRuntime(ENABLED);
    const options = { description: VALID_BRIEF, rewardUsdc: 0.5 };
    await taskMarketCreateTaskAction.handler(
      runtime,
      userMessage("post that task", "owner"),
      undefined,
      options,
    );
    const other = await taskMarketCreateTaskAction.handler(
      runtime,
      userMessage("yes", "someone-else"),
      undefined,
      options,
    );
    expect(other?.data).toMatchObject({ requiresConfirmation: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a reward below one atomic unit rather than posting zero", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await taskMarketCreateTaskAction.handler(
      makeRuntime(ENABLED),
      message,
      undefined,
      { description: VALID_BRIEF, rewardUsdc: 0.0000001 },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "invalid_param" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts atomic units and a bounded body once every guard passes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, taskId: "0xabc" }), {
        status: 200,
      }),
    );
    const { settled } = await createWithConfirmation(
      makeRuntime({ ...ENABLED, TASKMARKET_MAX_TASK_REWARD_USDC: "2" }),
      {
        description: VALID_BRIEF,
        rewardUsdc: 1.5,
        tags: "writing,research",
      },
    );
    expect(settled?.success).toBe(true);
    expect(settled?.data).toMatchObject({
      taskId: "0xabc",
      rewardUsdc: 1.5,
      rewardAtomic: "1500000",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.taskmarket.dev/api/tasks");
    const body = JSON.parse(String(init.body));
    expect(body.reward).toBe("1500000");
    expect(body.tags).toEqual(["writing", "research"]);
  });

  it("does not report an escrow when a 2xx body denies or omits creation", async () => {
    for (const payload of [
      { success: false },
      {},
      { success: true },
      { success: true, taskId: "" },
    ]) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      const { settled } = await createWithConfirmation(makeRuntime(ENABLED), {
        description: VALID_BRIEF,
        rewardUsdc: 0.5,
      });
      expect(settled?.success).toBe(false);
      expect(settled?.data).toMatchObject({ reason: "invalid_response" });
      expect(settled?.text).not.toContain("escrowed");
    }
  });
});

describe("TASKMARKET_BROWSE", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is unavailable without credentials and available with them", async () => {
    await expect(
      taskMarketBrowseAction.validate(makeRuntime({}), message),
    ).resolves.toBe(false);
    await expect(
      taskMarketBrowseAction.validate(makeRuntime(CONFIGURED), message),
    ).resolves.toBe(true);
  });

  it("sends the mandatory /api prefix and truncates long descriptions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          tasks: [
            {
              id: "0xdeadbeef",
              description: "x".repeat(9_000),
              reward: "4500000",
              netReward: "4162500",
              mode: "bounty",
              submissionCount: 3,
              submissionWindowOpen: true,
              expiryTime: "2026-08-22T11:58:25.795Z",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await taskMarketBrowseAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "list" },
    );
    expect(result?.success).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("https://api.taskmarket.dev/api/tasks");
    expect(url).toContain("status=open");
    // $4.50 gross / $4.16 net rendered from atomic units, not raw millions.
    expect(result?.text).toContain("$4.50");
    expect(result?.text).toContain("$4.16");
    expect(result?.text).toContain("[truncated");
    expect(result?.text?.length ?? 0).toBeLessThan(2_000);
  });

  it("reports an API error without leaking the bearer token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Provide address or agentId", { status: 500 }),
    );
    const result = await taskMarketBrowseAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "list" },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "api_error" });
    expect(result?.text).not.toContain("test-token");
  });

  it("requires taskId for subaction=get", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await taskMarketBrowseAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "get" },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "missing_param" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a malformed board as unavailable, not as an empty board", async () => {
    // `?? []` here would tell the planner there is no work when the API drifted.
    for (const payload of [{}, { tasks: null }, { tasks: [{ reward: "1" }] }]) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      const result = await taskMarketBrowseAction.handler(
        makeRuntime(CONFIGURED),
        message,
        undefined,
        { subaction: "list" },
      );
      expect(result?.success).toBe(false);
      expect(result?.data).toMatchObject({ reason: "invalid_response" });
      expect(result?.text).not.toContain("No matching");
    }
  });

  it("refuses to render an unparseable reward as $0.00", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ tasks: [{ id: "0xabc", reward: "not-a-number" }] }),
        { status: 200 },
      ),
    );
    const result = await taskMarketBrowseAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "list" },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "invalid_response" });
    // The task itself is never rendered — no summary line for it exists.
    expect(result?.text).not.toContain("- 0xabc");
  });
});

describe("TASKMARKET_STATUS", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the explicit workerAddress and renders the live submission shape", async () => {
    // Field names below are the ones GET /submissions/mine actually returns
    // (task-prefixed, no submission id, nullable rejectedAt) — verified live.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            taskId: "0xfeed",
            taskStatus: "open",
            taskMode: "bounty",
            taskReward: "15000000",
            submittedAt: "2026-08-06T07:05:33.552Z",
            deliverableHash: "0xdead",
            rejectedAt: null,
          },
          {
            taskId: "0xbeef",
            taskStatus: "resolved",
            taskMode: "bounty",
            taskReward: "2000000",
            submittedAt: "2026-08-07T07:05:33.552Z",
            rejectedAt: "2026-08-08T07:05:33.552Z",
          },
        ]),
        { status: 200 },
      ),
    );
    const result = await taskMarketStatusAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "submissions" },
    );
    expect(result?.success).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string];
    // The bearer token does not identify the worker; the address is mandatory.
    expect(url).toContain(
      "workerAddress=0x0000000000000000000000000000000000000001",
    );
    expect(result?.text).toContain("Submissions: 2 total");
    expect(result?.text).toContain("$15.00");
    expect(result?.text).toContain("submitted 2026-08-06T07:05:33.552Z");
    expect(result?.text).toContain("rejected");
  });

  it("requires the address setting alongside the token", async () => {
    await expect(
      taskMarketStatusAction.validate(
        makeRuntime({ TASKMARKET_API_TOKEN: "t" }),
        message,
      ),
    ).resolves.toBe(false);
  });

  it("reports a missing balance as unavailable, not as zero", async () => {
    // Telling the user they hold 0 USDC because a field went missing is worse
    // than telling them the read failed.
    // A fresh Response per call: `balance` fans out to two endpoints and a
    // Response body can only be read once.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const result = await taskMarketStatusAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "balance" },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ reason: "invalid_response" });
    expect(result?.text).not.toContain("0 USDC");
  });

  it("reports a malformed submissions payload as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ submissions: null }), { status: 200 }),
    );
    const result = await taskMarketStatusAction.handler(
      makeRuntime(CONFIGURED),
      message,
      undefined,
      { subaction: "submissions" },
    );
    expect(result?.success).toBe(false);
    expect(result?.text).not.toContain("No submissions yet");
  });
});
