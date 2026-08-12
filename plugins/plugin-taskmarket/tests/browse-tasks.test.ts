/** Exercises Taskmarket action rendering and boundary behavior with an injected deterministic client. */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createBrowseTaskmarketTasksAction } from "../src/actions/browse-tasks.js";
import type { TaskmarketTaskPage } from "../src/client.js";

const runtime = {} as IAgentRuntime;
const message = { content: { text: "find work", source: "test" } } as Memory;

const safePage: TaskmarketTaskPage = {
  tasks: [
    {
      id: "0xabc",
      description: "Implement a focused integration",
      rewardBaseUnits: "4500000",
      rewardUsdc: "4.5",
      netRewardBaseUnits: "4162500",
      netRewardUsdc: "4.1625",
      status: "open",
      mode: "bounty",
      expiryTime: "2026-08-12T00:00:00.000Z",
      tags: ["integration"],
      submissionCount: 2,
    },
  ],
  hasMore: false,
  nextCursor: null,
};

describe("BROWSE_TASKMARKET_TASKS", () => {
  it("merges nested parameters over direct options and calls back with rendered tasks", async () => {
    const listTasks = vi.fn(async () => safePage);
    const callback = vi.fn<HandlerCallback>();
    const action = createBrowseTaskmarketTasksAction(() => ({ listTasks }));

    const result = await action.handler(
      runtime,
      message,
      undefined,
      {
        limit: 2,
        mode: "claim",
        parameters: { limit: 5, mode: "bounty" },
      },
      callback,
    );
    if (!result) throw new TypeError("expected action result");

    expect(listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, mode: "bounty" }),
    );
    expect(result).toMatchObject({ success: true, data: { readOnly: true } });
    expect(result.text).toContain("4.1625 USDC net");
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Implement a focused integration"),
        actions: ["BROWSE_TASKMARKET_TASKS"],
      }),
    );
  });

  it("translates client failures through the action boundary and callback", async () => {
    const callback = vi.fn<HandlerCallback>();
    const action = createBrowseTaskmarketTasksAction(() => ({
      listTasks: async () => {
        throw new Error("upstream unavailable");
      },
    }));

    const result = await action.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback,
    );
    if (!result) throw new TypeError("expected action result");

    expect(result).toEqual({
      success: false,
      text: "Unable to browse Taskmarket tasks: upstream unavailable",
      data: { readOnly: true, error: "upstream unavailable" },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: result.text }),
    );
  });
});
