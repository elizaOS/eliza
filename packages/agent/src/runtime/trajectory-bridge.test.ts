/**
 * Unit coverage for the trajectory capture bridge in the DEFAULT lane (no real
 * DB). The full round-trip (real PGLite) lives in trajectory-capture.real.test.ts
 * — which skips under bun's isolated-install + vitest symlink layout — so this
 * test guards the ownership boundary that broke production: once installed,
 * the agent bridge owns lifecycle, capture, and reads as one SQL contract. It
 * must not also forward capture into the core writer, whose canonical step and
 * reward shapes cannot be fabricated from agent-only LLM steps. A mock adapter
 * records db.execute calls.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { flushTrajectoryWrites } from "./trajectory-storage.ts";

interface MockLogger {
  logLlmCall: (...args: unknown[]) => void;
  logProviderAccess: (...args: unknown[]) => void;
  startTrajectory?: (
    stepId: string,
    options: { agentId: string; source?: string },
  ) => Promise<string>;
  endTrajectory?: (stepId: string, status?: string) => Promise<void>;
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

function trajectoryInsertSql(execute: ReturnType<typeof vi.fn>): string[] {
  return execute.mock.calls
    .map(([query]) => sqlText(query))
    .filter((query) => /INSERT INTO trajectories\s*\(/i.test(query));
}

function makeRuntime() {
  const originalLogLlmCall = vi.fn();
  const originalLogProviderAccess = vi.fn();
  const originalExportTrajectories = vi.fn();
  const logger: MockLogger = {
    logLlmCall: originalLogLlmCall,
    logProviderAccess: originalLogProviderAccess,
    exportTrajectories: originalExportTrajectories,
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
  return {
    runtime,
    logger,
    originalLogLlmCall,
    originalLogProviderAccess,
    originalExportTrajectories,
    execute,
  };
}

describe("installDatabaseTrajectoryLogger (capture bridge)", () => {
  it("patches the resolved trajectories logger's logLlmCall", async () => {
    const { runtime, logger, originalLogLlmCall } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    expect(logger.logLlmCall).not.toBe(originalLogLlmCall);
    expect(typeof logger.logLlmCall).toBe("function");
  });

  it("routes capture exclusively through the agent SQL contract", async () => {
    const {
      runtime,
      logger,
      originalLogLlmCall,
      originalLogProviderAccess,
      execute,
    } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);

    logger.logProviderAccess({
      stepId: "step-1",
      providerName: "facts",
      purpose: "context",
      data: { count: 1 },
    });
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

    expect(originalLogLlmCall).not.toHaveBeenCalled();
    expect(originalLogProviderAccess).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
  });

  it("keeps canonical metrics valid across provider/LLM appends and completion", async () => {
    const { runtime, logger, execute } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);

    const stepId = await logger.startTrajectory?.("step-current", {
      agentId: runtime.agentId,
      source: "chat",
    });
    expect(stepId).toBe("step-current");
    await flushTrajectoryWrites(runtime);

    logger.logProviderAccess({
      stepId: "step-current",
      providerName: "facts",
      purpose: "context",
      data: { count: 1 },
    });
    await flushTrajectoryWrites(runtime);

    logger.logLlmCall({
      stepId: "step-current",
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

    await logger.endTrajectory?.("step-current", "completed");
    await flushTrajectoryWrites(runtime);

    const writes = trajectoryInsertSql(execute);
    expect(writes).toHaveLength(4);
    expect(
      writes.every(
        (query) =>
          query.includes("metrics_json") &&
          query.includes("metrics_json = EXCLUDED.metrics_json") &&
          query.includes('"episodeLength":1'),
      ),
    ).toBe(true);
    expect(
      writes
        .slice(0, 3)
        .every((query) => query.includes('"finalStatus":"active"')),
    ).toBe(true);
    expect(writes[3]).toContain('"finalStatus":"completed"');

    const stepWrites = execute.mock.calls
      .map(([query]) => sqlText(query))
      .filter((query) => /INSERT INTO trajectory_steps\s*\(/i.test(query));
    expect(
      stepWrites.some((query) => query.includes('"providerName":"facts"')),
    ).toBe(true);
    expect(
      stepWrites.some((query) => query.includes('"model":"eliza-1-2b"')),
    ).toBe(true);
  });

  it("falls back to the legacy schema only when canonical columns are rejected", async () => {
    const { runtime, logger, execute } = makeRuntime();
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        /INSERT INTO trajectories\s*\(/i.test(sql) &&
        sql.includes("metrics_json")
      ) {
        throw new Error("column metrics_json does not exist");
      }
      return [];
    });
    await installDatabaseTrajectoryLogger(runtime);

    logger.logLlmCall({
      stepId: "step-legacy",
      model: "eliza-1-2b",
      response: "hello",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    await flushTrajectoryWrites(runtime);

    const writes = trajectoryInsertSql(execute);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("metrics_json");
    expect(writes[1]).not.toContain("metrics_json");
    expect(writes[1]).toContain("episode_length");
  });

  it("does not mask a canonical write failure with a legacy write", async () => {
    const { runtime, logger, execute } = makeRuntime();
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (/INSERT INTO trajectories\s*\(/i.test(sql)) {
        throw new Error("connection reset");
      }
      return [];
    });
    await installDatabaseTrajectoryLogger(runtime);

    logger.logLlmCall({
      stepId: "step-failed",
      model: "eliza-1-2b",
      response: "hello",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    await flushTrajectoryWrites(runtime);

    const writes = trajectoryInsertSql(execute);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("metrics_json");
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
    const { runtime, logger, originalExportTrajectories, execute } =
      makeRuntime();

    await installDatabaseTrajectoryLogger(runtime);
    execute.mockClear();

    await logger.exportTrajectories?.({ format: "json", traceId: "trace-1" });

    expect(originalExportTrajectories).not.toHaveBeenCalled();
    expect(hasTraceFilter(execute, "trace-1")).toBe(true);
  });
});
