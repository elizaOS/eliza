/** Exercises the runtime-validated agent-log protocol with deterministic transport and clock seams. */

import { describe, expect, it, vi } from "vitest";
import {
  AgentLogsProtocolError,
  AgentLogsTimeoutError,
  AgentLogsUnavailableError,
  loadAgentLogs,
  parseAgentLogsJob as parseAgentLogsJobBoundary,
  parseAgentLogsStart,
} from "./agent-logs";

const TEST_JOB_ID = "123e4567-e89b-12d3-a456-426614174000";
const TEST_EXPECTATION = { agentId: "agent-1", tail: 200 } as const;

function parseAgentLogsJob(value: unknown) {
  return parseAgentLogsJobBoundary(value, TEST_EXPECTATION);
}

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
            jobId: TEST_JOB_ID,
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
            result: {
              cloudAgentId: "agent/one",
              status: "running",
              tail: 200,
              logs: "ready",
            },
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
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`/api/v1/jobs/${TEST_JOB_ID}`);
  });

  it("preserves an informational completion message separately from logs", () => {
    expect(
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: {
            cloudAgentId: "agent-1",
            status: "running",
            tail: 200,
            logs: "",
            message: "No container logs are available.",
          },
        },
      }),
    ).toEqual({
      kind: "complete",
      result: { logs: "", notice: "No container logs are available." },
    });
  });

  it("rejects the producer's completed agent-gone no-op as unavailable", () => {
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: {
            cloudAgentId: "agent-gone",
            skipped: true,
            reason: "Agent not found",
          },
        },
      }),
    ).toThrow(AgentLogsUnavailableError);
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: {
            cloudAgentId: "agent-gone",
            skipped: true,
            reason: "Agent not found",
          },
        },
      }),
    ).toThrow("This agent is no longer available");
  });

  it("rejects completed results without an explicit logs string", () => {
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: {
            cloudAgentId: "agent-1",
            status: "running",
            tail: 200,
          },
        },
      }),
    ).toThrow(AgentLogsUnavailableError);
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: {
            cloudAgentId: "agent-1",
            status: "running",
            tail: 200,
          },
        },
      }),
    ).toThrow("finished without log data");
  });

  it.each([
    ["provisioning", "Agent is provisioning — no container assigned yet."],
    [
      "running",
      "Logs unavailable: sandbox provider does not implement fetchLogs.",
    ],
  ])(
    "preserves the producer's message-only unavailable result: %s",
    (status, message) => {
      expect(
        parseAgentLogsJob({
          success: true,
          data: {
            type: "agent_logs",
            status: "completed",
            result: {
              cloudAgentId: "agent-1",
              status,
              tail: 200,
              message,
            },
          },
        }),
      ).toEqual({
        kind: "complete",
        result: { logs: "", notice: message },
      });
    },
  );

  it("keeps a bounded informational message well-formed at a surrogate boundary", () => {
    const result = parseAgentLogsJob({
      success: true,
      data: {
        type: "agent_logs",
        status: "completed",
        result: {
          cloudAgentId: "agent-1",
          status: "running",
          tail: 200,
          logs: "",
          message: `${"a".repeat(499)}😀`,
        },
      },
    });

    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.result.notice).toHaveLength(499);
    expect(result.result.notice?.isWellFormed()).toBe(true);
  });

  it("rejects arbitrary message-only completions and mismatched producer metadata", () => {
    expect(() =>
      parseAgentLogsJob({
        success: true,
        data: {
          type: "agent_logs",
          status: "completed",
          result: {
            cloudAgentId: "agent-1",
            status: "running",
            tail: 200,
            message: "arbitrary partial completion",
          },
        },
      }),
    ).toThrow("unsupported log outcome");

    expect(() =>
      parseAgentLogsJobBoundary(
        {
          success: true,
          data: {
            type: "agent_logs",
            status: "completed",
            result: {
              cloudAgentId: "different-agent",
              status: "running",
              tail: 999,
              logs: "different agent log",
            },
          },
        },
        TEST_EXPECTATION,
      ),
    ).toThrow("does not match the requested agent");

    expect(() =>
      parseAgentLogsJobBoundary(
        {
          success: true,
          data: {
            type: "agent_logs",
            status: "completed",
            result: {
              cloudAgentId: "agent-1",
              status: "running",
              tail: 999,
              logs: "wrong range",
            },
          },
        },
        TEST_EXPECTATION,
      ),
    ).toThrow("does not match the requested log range");
  });

  it.each([
    {
      label: "message-only notice",
      result: {
        cloudAgentId: "agent-1",
        status: "compromised",
        tail: 200,
        message: "Agent is compromised — no container assigned yet.",
      },
    },
    {
      label: "log payload",
      result: {
        cloudAgentId: "agent-1",
        status: "compromised",
        tail: 200,
        logs: "untrusted log output",
      },
    },
  ])(
    "rejects an unknown producer status before accepting $label",
    ({ result }) => {
      expect(() =>
        parseAgentLogsJob({
          success: true,
          data: {
            type: "agent_logs",
            status: "completed",
            result,
          },
        }),
      ).toThrow("invalid agent status");
    },
  );

  it.each([
    {},
    { success: true },
    { success: true, data: {} },
    { success: true, data: { jobId: "" } },
    { success: true, data: { jobId: "../another-job" } },
    { success: true, data: { jobId: `${"a".repeat(255)}😀` } },
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

  it("treats a cancelled log job as a terminal collection failure", () => {
    expect(
      parseAgentLogsJob({
        success: true,
        data: { type: "agent_logs", status: "cancelled", result: null },
      }),
    ).toEqual({
      kind: "failed",
      message: "Log collection failed on the server. Try again in a moment.",
    });
  });

  it("surfaces terminal failure without exposing infrastructure diagnostics", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { jobId: TEST_JOB_ID } }),
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

  it.each([
    [403, "You do not have permission to read this agent's logs."],
    [404, "This agent is no longer available."],
    [429, "Log requests are temporarily limited. Try again in a moment."],
  ])(
    "surfaces non-JSON request HTTP %i without parsing or accepting its body",
    async (status, message) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("not-json", { status }));

      await expect(
        loadAgentLogs({
          agentId: "agent-1",
          tail: 100,
          signal: new AbortController().signal,
          fetchImpl,
        }),
      ).rejects.toThrow(message);
    },
  );

  it("surfaces a non-JSON job HTTP failure before parsing its body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { jobId: TEST_JOB_ID } }),
      )
      .mockResolvedValueOnce(new Response("not-json", { status: 404 }));

    await expect(
      loadAgentLogs({
        agentId: "agent-1",
        tail: 100,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow("This log collection job is no longer available.");
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
          data: { jobId: TEST_JOB_ID, polling: { intervalMs: 500 } },
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

  it("bounds a non-cooperative hung enqueue request by the operation deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => await new Promise<Response>(() => {}));

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

  it("bounds a non-cooperative hung poll request by the same operation deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { jobId: TEST_JOB_ID } }),
      )
      .mockImplementationOnce(
        async () => await new Promise<Response>(() => {}),
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("passes the abort signal through every request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => await new Promise<Response>(() => {}));

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
