import type { IAgentRuntime } from "@elizaos/core";
import { setRestartHandler } from "@elizaos/host/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { setSelfApiTcpListenerBound } from "../api/self-api-endpoint";
import { runtimeAction } from "./runtime";

const runtime = { reportError: vi.fn() } as unknown as IAgentRuntime;

function run(parameters: Record<string, string>) {
  return runtimeAction.handler(runtime, {} as never, undefined, { parameters });
}

function stubReloadResponse() {
  setSelfApiTcpListenerBound(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            reloaded: true,
            applied: [],
            requiresRestart: ["plugins"],
          }),
          { status: 200 },
        ),
    ),
  );
}

afterEach(() => {
  setSelfApiTcpListenerBound(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Order matters: the handler is process-wide and has no uninstall.
it("refuses restart cleanly when the host installed no handler", async () => {
  const result = await run({ action: "restart", reason: "test" });
  expect(result).toMatchObject({
    success: false,
    text: "This host cannot restart the agent from chat.",
    values: { error: "RESTART_HANDLER_NOT_INSTALLED" },
    data: { op: "restart", refused: "no-restart-handler" },
  });
});

it("tells the user to restart the app when reload needs a restart and no handler exists", async () => {
  stubReloadResponse();
  const result = await run({ action: "reload_config" });
  expect(result?.success).toBe(true);
  expect(result?.text).toContain("Restart the app to apply them.");
  expect(result?.text).not.toContain("RUNTIME action=restart");
});

it("schedules the restart and offers the restart action once a handler exists", async () => {
  const handler = vi.fn();
  setRestartHandler(handler);
  stubReloadResponse();
  const reload = await run({ action: "reload_config" });
  expect(reload?.text).toContain("(run RUNTIME action=restart).");

  vi.useFakeTimers();
  const result = await run({ action: "restart", reason: "test" });
  expect(result).toMatchObject({ success: true, values: { restarting: true } });
  await vi.runAllTimersAsync();
  expect(handler).toHaveBeenCalledWith("test");
});
