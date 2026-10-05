// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-workflow";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workflow control accepted responses", () => {
  const cases = [
    {
      name: "cancel",
      path: "/executions/run-1/cancel",
      call: (client: ElizaClient) => client.cancelWorkflowExecution("run-1"),
    },
    {
      name: "approval",
      path: "/executions/run-1/approvals/gate/0",
      call: (client: ElizaClient) =>
        client.decideWorkflowApproval("run-1", "gate", 0, false),
    },
    {
      name: "signal",
      path: "/executions/run-1/signals/continue",
      call: (client: ElizaClient) =>
        client.signalWorkflowExecution("run-1", "continue", { value: 1 }),
    },
  ];

  it.each(cases)(
    "returns $name's 202 receipt without replaying its POST",
    async ({ call, path }) => {
      vi.useFakeTimers();
      const execution = { id: "run-1", status: "cancelled", finished: true };
      const fetch = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ execution }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const client = new ElizaClient("http://127.0.0.1:31742");
      const settled = call(client).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await vi.runAllTimersAsync();
      const outcome = await settled;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toEqual(execution);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toContain(path);
    },
  );

  it.each(cases)(
    "rejects $name's missing execution receipt without replaying its POST",
    async ({ call }) => {
      vi.useFakeTimers();
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "resuming" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const client = new ElizaClient("http://127.0.0.1:31742");
      const settled = call(client).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      expect(await settled).toBeInstanceOf(Error);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
