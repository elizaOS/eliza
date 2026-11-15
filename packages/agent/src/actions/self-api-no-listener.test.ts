import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSelfApiTcpListenerBound } from "../api/self-api-endpoint";
import { renderLiveStateForScope } from "../providers/page-scoped-live-state";
import { logsAction } from "./logs";
import { runtimeAction } from "./runtime";
import { terminalAction } from "./terminal";

const runtime = { reportError: vi.fn() } as unknown as IAgentRuntime;
const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("ELIZA_API_TOKEN", "agent-bearer");
});

afterEach(() => {
  setSelfApiTcpListenerBound(undefined);
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function noListener() {
  vi.stubEnv("ELIZA_LOCAL_AGENT_TRANSPORT", "filesystem-v1");
  vi.stubEnv("ELIZA_API_PORT", "");
}

it("does not offer TERMINAL_SHELL or send its request without a listener", async () => {
  noListener();
  expect(await terminalAction.validate(runtime, {} as never)).toBe(false);
  const result = await terminalAction.handler(runtime, {} as never, undefined, {
    parameters: { command: "echo hi" },
  });
  expect(result).toMatchObject({
    success: false,
    data: { executionStatus: "not_started" },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("does not offer TERMINAL_SHELL on a phone even with a listener", async () => {
  setSelfApiTcpListenerBound(true);
  vi.stubEnv("ELIZA_PLATFORM", "android");
  expect(await terminalAction.validate(runtime, {} as never)).toBe(false);
});

it("reports a refused connection as not started", async () => {
  setSelfApiTcpListenerBound(true);
  fetchSpy.mockRejectedValueOnce(
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    }),
  );
  const result = await terminalAction.handler(runtime, {} as never, undefined, {
    parameters: { command: "echo hi" },
  });
  expect(result).toMatchObject({
    success: false,
    data: { acceptance: "rejected", executionStatus: "not_started" },
  });
});

it("keeps logs, live state and reload off the network without a listener", async () => {
  noListener();
  const cleared = await logsAction.handler(runtime, {} as never, undefined, {
    parameters: { action: "delete" },
  });
  expect(cleared).toMatchObject({
    success: false,
    text: "The local API is not reachable in this build.",
  });
  // Reads run in process; this runtime registered no route kernel.
  const searched = await logsAction.handler(runtime, {} as never, undefined, {
    parameters: { action: "search" },
  });
  expect(searched?.success).toBe(false);
  expect(await renderLiveStateForScope(runtime, "page-apps")).toBe(
    "Live apps state: unavailable from the Apps API.",
  );
  const reload = await runtimeAction.handler(runtime, {} as never, undefined, {
    parameters: { action: "reload_config" },
  });
  expect(reload?.success).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});
