/**
 * MCP service wait — runtime factory gate that waits (with backoff) for the
 * mcp service to register. Pure unit tests with a stub runtime: no-mcp-plugin
 * fast path, immediate service, service that appears after a poll (backoff),
 * the 15s timeout path (warn, no throw), and the initialization/servers log
 * contract.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const loggerWarn = mock();
const loggerDebug = mock();
const loggerInfo = mock();

mock.module("@elizaos/core", () => ({
  elizaLogger: {
    warn: loggerWarn,
    debug: loggerDebug,
    info: loggerInfo,
    error: mock(),
  },
}));

const { waitForMcpServiceIfNeeded } = await import("../mcp-service-wait");

beforeEach(() => {
  loggerWarn.mockReset();
  loggerDebug.mockReset();
  loggerInfo.mockReset();
});

function makeRuntime(getService: (name: string) => unknown) {
  return { getService };
}

describe("waitForMcpServiceIfNeeded", () => {
  test("returns immediately when the mcp plugin is not loaded", async () => {
    const runtime = makeRuntime(() => {
      throw new Error("getService must not be called without the mcp plugin");
    });
    await waitForMcpServiceIfNeeded(runtime as never, [{ name: "browser" }] as never);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  test("waits for and initializes a service that appears after a poll", async () => {
    const waitForInitialization = mock().mockResolvedValue(undefined);
    const getService = mock()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        waitForInitialization,
        getServers: () => [],
      });
    const runtime = makeRuntime(getService);

    await waitForMcpServiceIfNeeded(runtime as never, [{ name: "mcp" }] as never);

    expect(getService).toHaveBeenCalledWith("mcp");
    expect(getService.mock.calls.length).toBeGreaterThan(1);
    expect(waitForInitialization).toHaveBeenCalledTimes(1);
  });

  test("initializes an immediately-available service and logs connected servers", async () => {
    const waitForInitialization = mock().mockResolvedValue(undefined);
    const runtime = makeRuntime(() => ({
      waitForInitialization,
      getServers: () => [{ name: "github", status: "connected", tools: [1, 2] }],
    }));

    await waitForMcpServiceIfNeeded(runtime as never, [{ name: "mcp" }] as never);

    expect(waitForInitialization).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalled();
    expect(loggerInfo.mock.calls.some((call) => String(call[0]).includes("1 server(s)"))).toBe(
      true,
    );
  });

  test("warns and returns without throwing when the service never appears", async () => {
    // The module's 15s max-wait is a module constant; drive the poll loop with
    // deterministic fake timers instead of sleeping 15s in the test.
    const realSetTimeout = globalThis.setTimeout;
    const realDateNow = Date.now;
    let fakeNow = 0;
    globalThis.setTimeout = ((fn: () => void) => {
      fakeNow += 250; // advance past the backoff ceiling per poll
      fn();
      return 0;
    }) as typeof setTimeout;
    Date.now = () => fakeNow;

    const runtime = makeRuntime(() => null);
    try {
      await waitForMcpServiceIfNeeded(runtime as never, [{ name: "mcp" }] as never);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      Date.now = realDateNow;
    }

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(String(loggerWarn.mock.calls[0][0])).toContain("MCP service not available");
    // No initialization, no throw.
  });

  test("skips getServers logging when the service exposes no getServers", async () => {
    const runtime = makeRuntime(() => ({
      waitForInitialization: mock().mockResolvedValue(undefined),
    }));

    await waitForMcpServiceIfNeeded(runtime as never, [{ name: "mcp" }] as never);

    expect(loggerInfo).not.toHaveBeenCalled();
  });
});
