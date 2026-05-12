import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ResponseHandlerFieldContext,
  ResponseHandlerResult,
  State,
} from "@elizaos/core";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";
import { workThreadAction } from "../src/actions/work-thread.ts";
import {
  type ThreadOp,
  threadOpsFieldEvaluator,
} from "../src/lifeops/work-threads/field-evaluator-thread-ops.ts";
import { createWorkThreadStore } from "../src/lifeops/work-threads/store.ts";
import { workThreadsProvider } from "../src/providers/work-threads.ts";

type Sample = {
  name: string;
  ms: number;
};

const samples: Sample[] = [];

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = nowMs();
  try {
    return await fn();
  } finally {
    samples.push({ name, ms: nowMs() - start });
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function message(runtime: IAgentRuntime, roomId: string, text: string): Memory {
  return {
    id: `${roomId}:bench:${Math.random().toString(36).slice(2)}` as Memory["id"],
    entityId: runtime.agentId,
    roomId: roomId as Memory["roomId"],
    agentId: runtime.agentId,
    content: {
      text,
      source: "benchmark",
      channelType: "dm",
    },
    metadata: {
      provider: "benchmark",
      group: { name: roomId },
    },
    createdAt: Date.now(),
  } as Memory;
}

function state(): State {
  return { values: {}, data: {}, text: "" } as State;
}

function fieldContext(
  runtime: IAgentRuntime,
  msg: Memory,
): ResponseHandlerFieldContext {
  return {
    runtime,
    message: msg,
    state: state(),
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
  };
}

function responseHandlerResult(): ResponseHandlerResult {
  return {
    shouldRespond: "RESPOND",
    contexts: [],
    intents: [],
    candidateActionNames: [],
    replyText: "",
    facts: [],
    relationships: [],
    addressedTo: [],
  };
}

async function applyThreadOpsField(
  runtime: IAgentRuntime,
  msg: Memory,
  ops: ThreadOp[],
): Promise<ResponseHandlerResult> {
  const parsed = responseHandlerResult();
  parsed.threadOps = ops;
  const effect = await threadOpsFieldEvaluator.handle?.({
    ...fieldContext(runtime, msg),
    value: ops,
    parsed,
  });
  effect?.mutateResult?.(parsed);
  return parsed;
}

async function runThreadAction(
  runtime: IAgentRuntime,
  msg: Memory,
  operations: unknown[],
): Promise<ActionResult> {
  const result = await workThreadAction.handler?.(
    runtime,
    msg,
    state(),
    { parameters: { operations } } as HandlerOptions,
    undefined,
  );
  if (!result || typeof result !== "object" || !("success" in result)) {
    throw new Error("workThreadAction returned a non-ActionResult");
  }
  return result as ActionResult;
}

function operationResults(
  result: ActionResult,
): Array<Record<string, unknown>> {
  const operations = result.data?.operations;
  if (!Array.isArray(operations)) {
    throw new Error("expected thread operation results");
  }
  return operations as Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const mocked = await createMockedTestRuntime({
    envs: [],
    seedGoogle: false,
    seedX: false,
    seedBenchmarkFixtures: false,
    withLLM: false,
  });

  try {
    const runtime = mocked.runtime;
    const roomA = message(runtime, "bench-room-a", "start a thread");
    const roomB = message(runtime, "bench-room-b", "continue this thread");
    const threadIds: string[] = [];

    for (let i = 0; i < 12; i += 1) {
      const created = await measure("create", () =>
        runThreadAction(runtime, roomA, [
          {
            type: "create",
            title: `Bench thread ${i}`,
            summary: "Benchmark coordination record.",
          },
        ]),
      );
      if (!created.success) {
        throw new Error(`create failed: ${JSON.stringify(created.data)}`);
      }
      threadIds.push(operationResults(created)[0].workThreadId as string);
    }

    for (const threadId of threadIds.slice(0, 6)) {
      const steered = await measure("steer", () =>
        runThreadAction(runtime, roomA, [
          {
            type: "steer",
            workThreadId: threadId,
            instruction: `Benchmark steer ${threadId}`,
          },
        ]),
      );
      if (!steered.success) {
        throw new Error(`steer failed: ${JSON.stringify(steered.data)}`);
      }
    }

    for (let i = 0; i < 30; i += 1) {
      const provider = await measure("provider", () =>
        workThreadsProvider.get(runtime, roomA, state()),
      );
      if (!provider.values?.workThreadCount) {
        throw new Error("provider failed to surface active work threads");
      }
      const shouldRun = await measure("evaluator.shouldRun", () =>
        Promise.resolve(
          threadOpsFieldEvaluator.shouldRun?.(fieldContext(runtime, roomA)),
        ),
      );
      if (!shouldRun) {
        throw new Error("evaluator shouldRun returned false for active work");
      }
      const staged = await measure("evaluator.handle", () =>
        applyThreadOpsField(runtime, roomA, [
          {
            type: "steer",
            workThreadId: threadIds[0],
            instruction: "Benchmark route through threadOps.",
          },
        ]),
      );
      if (!staged.candidateActionNames.includes("work_thread")) {
        throw new Error("field evaluator did not stage planner routing");
      }
    }

    const sourceId = threadIds[0];
    const targetA = threadIds[1];
    const targetB = threadIds[2];
    const attached = await measure("attach_source", () =>
      runThreadAction(runtime, roomB, [
        { type: "attach_source", workThreadId: sourceId },
      ]),
    );
    if (!attached.success) {
      throw new Error(`attach_source failed: ${JSON.stringify(attached.data)}`);
    }
    const mergeResults = await measure("competing_merge_pair", () =>
      Promise.all([
        runThreadAction(runtime, roomA, [
          {
            type: "merge",
            workThreadId: targetA,
            sourceWorkThreadIds: [sourceId],
            instruction: "Benchmark merge into A.",
          },
        ]),
        runThreadAction(runtime, roomB, [
          {
            type: "merge",
            workThreadId: targetB,
            sourceWorkThreadIds: [sourceId],
            instruction: "Benchmark merge into B.",
          },
        ]),
      ]),
    );
    if (mergeResults.filter((result) => result.success).length !== 1) {
      throw new Error(
        `expected exactly one competing merge success: ${JSON.stringify(
          mergeResults.map((result) => result.data),
        )}`,
      );
    }
    const source = await createWorkThreadStore(runtime).get(sourceId);
    if (source?.status !== "stopped") {
      throw new Error(`merge source was not stopped: ${source?.status}`);
    }
  } finally {
    await mocked.cleanup();
  }

  const byName = new Map<string, number[]>();
  for (const sample of samples) {
    const bucket = byName.get(sample.name) ?? [];
    bucket.push(sample.ms);
    byName.set(sample.name, bucket);
  }

  console.log("[work-thread-benchmark] operation,count,avg_ms,p50_ms,p95_ms");
  for (const [name, values] of [...byName.entries()].sort()) {
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(
      `[work-thread-benchmark] ${name},${values.length},${avg.toFixed(2)},${percentile(values, 50).toFixed(2)},${percentile(values, 95).toFixed(2)}`,
    );
  }
}

await main();
