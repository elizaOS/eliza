/** Exercises the runtime-validated agent-log protocol with deterministic transport and clock seams. */

import { describe, expect, it, vi } from "vitest";
import {
  AgentLogsProtocolError,
  AgentLogsTimeoutError,
  loadAgentLogs,
  parseAgentLogsJob,
  parseAgentLogsStart,
} from "./agent-logs";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("agent log protocol", () => {
  it("accepts the legacy immediate log response", () => {
    expect(parseAgentLogsStart({ success: true, data: "one\ntwo" })).toEqual({
      kind: "complete",
      result: { logs: "one\ntwo", notice: null },
    });
  });

  it("requires a valid enqueue job and ignores untrusted polling endpoints", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            jobId: "job/one",
            polling: {
              endpoint: "https://evil.example/collect",
              intervalMs: 1,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            type: "agent_logs",
            status: "completed",
            result: { logs: "ready" },
          },
          polling: { shouldContinue: false },
        }),
      );

    await expect(
      loadAgentLogs({
        agentId: "agent/one",
        tail: 200,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).resolves.toEqual({ logs: "ready", notice: null });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "/api/compat/agents/agent%2Fone/logs?tail=200",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/v1/jobs/job%2Fone");
  });

  it("preserves an informational completion message separately from logs", () => {
    expect(
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: { logs: "", message: "No container logs are available." },
        },
      }),
    ).toEqual({
      kind: "complete",
      result: { logs: "", notice: "No container logs are available." },
    });
  });

  it.each([
    {},
    { success: true },
    { success: true, data: {} },
    { success: true, data: { jobId: "" } },
  ])("rejects malformed enqueue envelopes", (body) => {
    expect(() => parseAgentLogsStart(body)).toThrow(AgentLogsProtocolError);
  });

  it.each([
    {},
    { success: true },
    { success: true, data: { status: "mystery" } },
    { success: true, data: { status: "completed", result: null } },
    {
      success: true,
      data: { status: "completed", result: { logs: 42 } },
    },
  ])("rejects malformed job envelopes", (body) => {
    expect(() => parseAgentLogsJob(body)).toThrow(AgentLogsProtocolError);
  });

  it("rejects another job type and a contradictory polling stop", () => {
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_snapshot",
          status: "completed",
          result: { logs: "wrong job" },
        },
      }),
    ).toThrow("not for agent logs");
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: { type: "agent_logs", status: "in_progress", result: null },
        polling: { shouldContinue: false },
      }),
    ).toThrow("stopped polling");
  });

  it("surfaces terminal failure without exposing infrastructure diagnostics", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { jobId: "job-1" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            type: "agent_logs",
            status: "failed",
            error:
              "[docker-ssh] Command failed on 198.51.100.24: No such container agent-secret-id",
          },
        }),
      );

    const error = await loadAgentLogs({
      agentId: "agent-1",
      tail: 100,
      signal: new AbortController().signal,
      fetchImpl,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AgentLogsProtocolError);
    expect((error as Error).message).toBe(
      "Log collection failed on the server. Try again in a moment.",
    );
    expect((error as Error).message).not.toMatch(
      /198\.51\.100\.24|agent-secret-id/,
    );
  });

  it("rejects a completed job that still carries a job-level error", () => {
    expect(
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          error: "Completion was not durable",
          result: { logs: "misleading" },
        },
      }),
    ).toEqual({
      kind: "failed",
      message: "Log collection failed on the server. Try again in a moment.",
    });
  });

  it("surfaces HTTP failures without accepting their data", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { success: false, error: "You cannot read this agent's logs." },
          403,
        ),
      );

    await expect(
      loadAgentLogs({
        agentId: "agent-1",
        tail: 100,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow("You do not have permission to read this agent's logs.");
  });

  it("surfaces malformed JSON as a protocol failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(
      loadAgentLogs({
        agentId: "agent-1",
        tail: 100,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow("The log request returned unreadable JSON.");
  });

  it("surfaces timeout as a typed failure", async () => {
    let time = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { jobId: "job-1", polling: { intervalMs: 500 } },
        }),
      )
      .mockImplementation(async () =>
        jsonResponse({
          success: true,
          data: { type: "agent_logs", status: "in_progress", result: null },
          polling: { intervalMs: 500, shouldContinue: true },
        }),
      );

    await expect(
      loadAgentLogs({
        agentId: "agent-1",
        tail: 100,
        signal: new AbortController().signal,
        fetchImpl,
        timeoutMs: 1_000,
        now: () => time,
        wait: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).rejects.toBeInstanceOf(AgentLogsTimeoutError);
  });

  it("aborts a hung enqueue request when the operation deadline expires", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    const promise = loadAgentLogs({
      agentId: "agent-1",
      tail: 100,
      signal: new AbortController().signal,
      fetchImpl,
      timeoutMs: 1_000,
    });
    const rejection = expect(promise).rejects.toBeInstanceOf(
      AgentLogsTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("passes the abort signal through every request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
        throw new Error("unreachable");
      });

    const promise = loadAgentLogs({
      agentId: "agent-1",
      tail: 100,
      signal: controller.signal,
      fetchImpl,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
