/**
 * Unit coverage for the trajectory capture bridge in the DEFAULT lane (no real
 * DB). The full round-trip (real PGLite) lives in trajectory-capture.real.test.ts
 * — which skips under bun's isolated-install + vitest symlink layout — so this
 * test guards the two things that actually broke production: (1)
 * installDatabaseTrajectoryLogger patches the resolved "trajectories" logger's
 * logLlmCall (the capture primitive recordUseModelTrajectory calls), and (2) a
 * captured call is routed to the SQL adapter (trajectory_steps), not just the
 * core service's in-memory store. A mock adapter records db.execute calls.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { flushTrajectoryWrites } from "./trajectory-storage.ts";

interface MockLogger {
  logLlmCall: (...args: unknown[]) => void;
  logProviderAccess: (...args: unknown[]) => void;
  listTrajectories?: (options?: {
    limit?: number;
    offset?: number;
    traceId?: string;
  }) => Promise<unknown>;
  exportTrajectories?: (options: {
    format: "json";
    traceId?: string;
  }) => Promise<unknown>;
  isEnabled: () => boolean;
  setEnabled: (v: boolean) => void;
  llmCalls: unknown[];
  providerAccess: unknown[];
}

function makeRuntime() {
  const originalLogLlmCall = vi.fn();
  const logger: MockLogger = {
    logLlmCall: originalLogLlmCall,
    logProviderAccess: vi.fn(),
    isEnabled: () => true,
    setEnabled: () => {},
    llmCalls: [],
    providerAccess: [],
  };
  const execute = vi.fn().mockResolvedValue([]);
  const runtime = {
    agentId: "agent-bridge-test",
    adapter: { db: { execute } },
    getService: (t: string) => (t === "trajectories" ? logger : null),
    getServicesByType: (t: string) => (t === "trajectories" ? [logger] : []),
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as AgentRuntime;
  return { runtime, logger, originalLogLlmCall, execute };
}

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
    .queryChunks;
  if (!Array.isArray(chunks)) return String(value);
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .join("");
}

function hasTraceFilter(execute: ReturnType<typeof vi.fn>, traceId: string) {
  return execute.mock.calls.some(([query]) =>
    sqlText(query).includes(`trace_id = '${traceId}'`),
  );
}

describe("installDatabaseTrajectoryLogger (capture bridge)", () => {
  it("patches the resolved trajectories logger's logLlmCall", async () => {
    const { runtime, logger, originalLogLlmCall } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    expect(logger.logLlmCall).not.toBe(originalLogLlmCall);
    expect(typeof logger.logLlmCall).toBe("function");
  });

  it("routes a captured LLM call to the SQL adapter (trajectory_steps) while preserving the original logger", async () => {
    const { runtime, logger, originalLogLlmCall, execute } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);

    logger.logLlmCall({
      stepId: "step-1",
      model: "eliza-1-2b",
      modelType: "TEXT_LARGE",
      provider: "local-inference",
      response: "hello",
      temperature: 0,
      maxTokens: 64,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 5,
    });
    await flushTrajectoryWrites(runtime);

    // The wrap calls the core service's original logger (in-memory store) ...
    expect(originalLogLlmCall).toHaveBeenCalledTimes(1);
    // ... and ALSO persists to the SQL store the viewer reads (the bug fix).
    expect(execute).toHaveBeenCalled();
  });

  it("is idempotent — re-installing does not double-wrap", async () => {
    const { runtime, logger } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    const patched = logger.logLlmCall;
    await installDatabaseTrajectoryLogger(runtime);
    expect(logger.logLlmCall).toBe(patched);
  });

  it("applies traceId filters to the SQL-backed list reader", async () => {
    const { runtime, logger, execute } = makeRuntime();
    execute.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);

    await installDatabaseTrajectoryLogger(runtime);
    await logger.listTrajectories?.({ traceId: "trace-1", limit: 10 });

    expect(hasTraceFilter(execute, "trace-1")).toBe(true);
  });

  it("applies traceId filters to the compatibility export reader", async () => {
    const { runtime, logger, execute } = makeRuntime();

    await installDatabaseTrajectoryLogger(runtime);
    execute.mockClear();

    await logger.exportTrajectories?.({ format: "json", traceId: "trace-1" });

    expect(hasTraceFilter(execute, "trace-1")).toBe(true);
  });
});
