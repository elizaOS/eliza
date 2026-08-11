/** Verifies Taskmarket client parsing and failure behavior with deterministic HTTP fixtures. */

import { describe, expect, it, vi } from "vitest";
import { formatUsdc, TaskmarketClient } from "../src/client.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const validTask = {
  id: "0xabc",
  description: "Implement a focused integration",
  reward: "4500000",
  netReward: "4162500",
  status: "open",
  mode: "bounty",
  expiryTime: "2026-08-12T00:00:00.000Z",
  tags: ["integration"],
  submissionCount: 2,
};

describe("formatUsdc", () => {
  it.each([
    ["0", "0"],
    ["1", "0.000001"],
    ["1000000", "1"],
    ["4162500", "4.1625"],
  ])("formats %s base units", (input, expected) => {
    expect(formatUsdc(input)).toBe(expected);
  });
});

describe("TaskmarketClient", () => {
  it("returns typed, formatted tasks and sends supported filters", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      response({ tasks: [validTask], hasMore: false, nextCursor: null }),
    );
    const page = await new TaskmarketClient(
      "https://example.test",
      fetcher as typeof fetch,
    ).listTasks({
      limit: 5,
      mode: "bounty",
      sort: "deadline_asc",
      minRewardBaseUnits: "1000000",
      deadlineHours: 24,
    });
    const url = fetcher.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL))
      throw new TypeError("expected Taskmarket request URL");
    expect(url.searchParams.get("mode")).toBe("bounty");
    expect(url.searchParams.get("deadlineHours")).toBe("24");
    expect(page.tasks[0]).toMatchObject({
      rewardUsdc: "4.5",
      netRewardUsdc: "4.1625",
    });
  });

  it("returns an explicit empty page", async () => {
    const fetcher = vi.fn(async () =>
      response({ tasks: [], hasMore: false, nextCursor: null }),
    );
    await expect(
      new TaskmarketClient(
        "https://example.test",
        fetcher as typeof fetch,
      ).listTasks(),
    ).resolves.toEqual({
      tasks: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("rejects invalid remote task shapes", async () => {
    const fetcher = vi.fn(async () =>
      response({
        tasks: [{ ...validTask, reward: 4.5 }],
        hasMore: false,
        nextCursor: null,
      }),
    );
    await expect(
      new TaskmarketClient(
        "https://example.test",
        fetcher as typeof fetch,
      ).listTasks(),
    ).rejects.toThrow("missing reward");
  });

  it("reports HTTP failures", async () => {
    const fetcher = vi.fn(async () => response({ error: "unavailable" }, 503));
    await expect(
      new TaskmarketClient(
        "https://example.test",
        fetcher as typeof fetch,
      ).listTasks(),
    ).rejects.toThrow("HTTP 503");
  });

  it("validates local filters before requesting", async () => {
    const fetcher = vi.fn();
    await expect(
      new TaskmarketClient(
        "https://example.test",
        fetcher as typeof fetch,
      ).listTasks({ limit: 0 }),
    ).rejects.toThrow("between 1 and 50");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
