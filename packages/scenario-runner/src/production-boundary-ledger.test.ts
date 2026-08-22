/**
 * Proves the durable observation ledger against the production scheduling
 * connector adapter, including typed DispatchResult classification, canonical
 * readback, injected clock timestamps, restart continuity, redaction, and every
 * supported synthetic boundary fault.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { DispatchResult } from "@elizaos/plugin-scheduling";
import { dispatchViaMessageConnector } from "@elizaos/plugin-scheduling/scheduled-task/connector-dispatch";
import type { ScheduledTaskDispatchRecord } from "@elizaos/plugin-scheduling/scheduled-task/runner";
import { afterEach, describe, expect, it } from "vitest";

import {
  type BoundaryFaultDirective,
  type BoundaryGenerationFence,
  type BoundaryResultClassification,
  JsonlBoundaryObservationLedger,
  observeProductionBoundary,
  type ProductionBoundaryIdentity,
} from "./production-boundary-ledger.ts";
import { canonicalSha256 } from "./provider-qualified/manifest.ts";
import { createScenarioRuntime } from "./runtime-factory.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createLedger(): Promise<{
  ledger: JsonlBoundaryObservationLedger;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "eliza-boundary-ledger-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "observations.jsonl");
  return { ledger: new JsonlBoundaryObservationLedger(path), path };
}

function identity(
  overrides: Partial<ProductionBoundaryIdentity> = {},
): ProductionBoundaryIdentity {
  return {
    surface: "connector.dispatch",
    target: "discord:user:owner-1",
    idempotencyKey: "task-1:2026-08-21T12:00:00.000Z",
    generation: "generation-7",
    workerId: "scheduler-worker-2",
    taskId: "task-1",
    retry: { attempt: 1 },
    ...overrides,
  };
}

function scheduledRecord(): ScheduledTaskDispatchRecord {
  return {
    taskId: "task-1",
    kind: "reminder",
    firedAtIso: "2026-08-21T12:00:00.000Z",
    channelKey: "discord",
    promptInstructions: "Deliver the reminder.",
    contextRequest: undefined,
    output: {
      destination: "channel",
      target: "discord:user:owner-1",
    },
  };
}

function dispatchClassification(result: DispatchResult | null): {
  acceptance: "accepted" | "rejected" | "unknown";
  code: string;
  retryable: boolean;
} {
  if (result?.ok) {
    return { acceptance: "accepted", code: "delivered", retryable: false };
  }
  if (!result || result.acceptance === "unknown") {
    return { acceptance: "unknown", code: "unknown", retryable: false };
  }
  return {
    acceptance: "rejected",
    code: result.reason,
    retryable: result.retryAfterMinutes !== undefined,
  };
}

function clock(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)] as string);
}

function generationFence(
  activeGeneration: () => string = () => "generation-7",
): BoundaryGenerationFence {
  return {
    withGeneration: async (expectedGeneration, operation) =>
      operation({
        isCurrent: async () => activeGeneration() === expectedGeneration,
      }),
  };
}

function exclusiveGenerationFence(initialGeneration: string): {
  fence: BoundaryGenerationFence;
  rollover(nextGeneration: string): Promise<void>;
} {
  let generation = initialGeneration;
  let tail = Promise.resolve();
  const fence: BoundaryGenerationFence = {
    async withGeneration(expectedGeneration, operation) {
      const previous = tail;
      let release: () => void = () => undefined;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation({
          isCurrent: async () => generation === expectedGeneration,
        });
      } finally {
        release();
      }
    },
  };
  return {
    fence,
    rollover: async (nextGeneration) => {
      await fence.withGeneration(generation, async (guard) => {
        expect(await guard.isCurrent()).toBe(true);
        generation = nextGeneration;
      });
    },
  };
}

function runtimeWithReadback() {
  const effects: Array<{
    target: unknown;
    content: unknown;
    messageId: string;
  }> = [];
  const runtime = {
    getMessageConnectors: () => [{ source: "discord" }],
    reportError: () => undefined,
    sendMessageToTarget: async (target: unknown, content: unknown) => {
      const messageId = `provider-${effects.length + 1}`;
      effects.push({ target, content, messageId });
      return {
        kind: "delivered",
        receipt: {
          providerMessageIds: [messageId],
          acceptedAt: Date.parse("2026-08-21T12:00:01.000Z"),
          persistence: { status: "persisted", memoryIds: ["memory-1"] },
        },
        memories: [],
      };
    },
  } as unknown as IAgentRuntime;
  return { runtime, effects };
}

describe("production boundary observation ledger", () => {
  it("does not expose a public writer capability", async () => {
    const { ledger } = await createLedger();
    expect("append" in ledger).toBe(false);
    expect(Object.keys(ledger)).not.toContain("append");

    let calls = 0;
    await expect(
      observeProductionBoundary({
        ledger: { readAll: async () => [] },
        identity: identity(),
        payload: { value: 1 },
        now: clock("2026-08-21T12:00:00.000Z"),
        generationFence: generationFence(),
        invoke: async () => {
          calls += 1;
          return { id: "effect" };
        },
        classify: () => ({
          acceptance: "accepted",
          code: "accepted",
          retryable: false,
        }),
        readback: async () => ({ id: "effect" }),
        verifyReadback: () => true,
      }),
    ).rejects.toMatchObject({ code: "BOUNDARY_LEDGER_WRITER_UNAVAILABLE" });
    expect(calls).toBe(0);
  });

  it("records a typed connector call only after matching authoritative readback", async () => {
    const { ledger, path } = await createLedger();
    const { runtime, effects } = runtimeWithReadback();
    const record = scheduledRecord();
    const observation = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: {
        record,
        authorization: "Bearer raw-secret",
        nested: { apiKey: "raw-key" },
      },
      now: clock("2026-08-21T12:00:00.000Z", "2026-08-21T12:00:02.000Z"),
      generationFence: generationFence(),
      invoke: () =>
        dispatchViaMessageConnector(runtime, record, "Take medication."),
      classify: dispatchClassification,
      readback: async () => effects[0] ?? null,
      verifyReadback: (result, readback) =>
        Boolean(result?.ok && result.messageId === readback.messageId),
      redactText: (text) => text.replace(/raw-secret|raw-key/g, REDACTED_TEST),
    });

    expect(observation).toMatchObject({
      order: 1,
      surface: "connector.dispatch",
      target: "discord:user:owner-1",
      generation: "generation-7",
      workerId: "scheduler-worker-2",
      taskId: "task-1",
      attempt: 1,
      boundaryCalled: true,
      acceptance: "accepted",
      result: "succeeded",
      resultCode: "delivered",
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:00:02.000Z",
    });
    expect(observation.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.readbackSha256).toMatch(/^[0-9a-f]{64}$/);
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("raw-secret");
    expect(persisted).not.toContain("raw-key");
  });

  it("records success only after independent PGlite repository readback", async () => {
    const { ledger } = await createLedger();
    const runtimeResult = await createScenarioRuntime({
      useDeterministicModel: true,
    });
    const taskId = "8a611d10-c2c1-4e90-a6a1-45f250d8ca31" as UUID;
    try {
      const observation = await observeProductionBoundary({
        ledger,
        identity: identity({
          surface: "task.create",
          target: taskId,
          idempotencyKey: `task-create:${taskId}`,
        }),
        payload: { id: taskId, name: "BOUNDARY_PGLITE_READBACK" },
        now: clock("2026-08-21T12:00:00.000Z", "2026-08-21T12:00:02.000Z"),
        generationFence: generationFence(),
        invoke: async () => {
          await runtimeResult.runtime.createTask({
            id: taskId,
            name: "BOUNDARY_PGLITE_READBACK",
            agentId: runtimeResult.runtime.agentId,
            tags: ["scenario-boundary"],
          });
          return { taskId };
        },
        classify: () => ({
          acceptance: "accepted",
          code: "task_created",
          retryable: false,
        }),
        readback: () => runtimeResult.runtime.getTask(taskId),
        verifyReadback: (response, task) =>
          task.id === response.taskId &&
          task.name === "BOUNDARY_PGLITE_READBACK",
      });
      expect(observation.result).toBe("succeeded");
      await expect(
        runtimeResult.runtime.getTask(taskId),
      ).resolves.toMatchObject({
        id: taskId,
        name: "BOUNDARY_PGLITE_READBACK",
      });
    } finally {
      await runtimeResult.cleanup();
    }
  }, 120_000);

  it("cannot record success when the adapter was not called or readback is absent/mismatched", async () => {
    const { ledger } = await createLedger();
    let calls = 0;
    const common = {
      ledger,
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => {
        calls += 1;
        return { accepted: true, id: `effect-${calls}` };
      },
      classify: () => ({
        acceptance: "accepted" as const,
        code: "accepted",
        retryable: false,
      }),
      verifyReadback: (response: { id: string }, readback: { id: string }) =>
        response.id === readback.id,
    };

    const timeout = await observeProductionBoundary({
      ...common,
      identity: identity(),
      readback: async () => null,
      fault: { kind: "timeout", message: "deadline exceeded" },
    });
    expect(timeout).toMatchObject({
      boundaryCalled: false,
      result: "timeout",
    });
    expect(calls).toBe(0);

    const missing = await observeProductionBoundary({
      ...common,
      identity: identity({
        retry: { attempt: 2, retryOfObservationId: timeout.observationId },
      }),
      readback: async () => null,
    });
    expect(missing).toMatchObject({
      boundaryCalled: true,
      result: "readback_missing",
      retryOfObservationId: timeout.observationId,
    });

    const mismatch = await observeProductionBoundary({
      ...common,
      identity: identity({
        idempotencyKey: "task-2:2026-08-21T12:00:00.000Z",
      }),
      readback: async () => ({ id: "different-effect" }),
    });
    expect(mismatch.result).toBe("readback_mismatch");
    expect((await ledger.readAll()).map((entry) => entry.order)).toEqual([
      1, 2, 3,
    ]);
  });

  it("rejects invalid retry lineage before invoking the boundary", async () => {
    const { ledger } = await createLedger();
    let calls = 0;
    const common = {
      ledger,
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => {
        calls += 1;
        return { id: "effect" };
      },
      classify: () => ({
        acceptance: "accepted" as const,
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect" }),
      verifyReadback: () => true,
    };

    await expect(
      observeProductionBoundary({
        ...common,
        identity: identity({
          retry: {
            attempt: 2,
            retryOfObservationId: "0".repeat(64),
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "BOUNDARY_RETRY_LINEAGE_INVALID" });
    expect(calls).toBe(0);

    const terminal = await observeProductionBoundary({
      ...common,
      identity: identity(),
    });
    expect(terminal.retryable).toBe(false);
    await expect(
      observeProductionBoundary({
        ...common,
        identity: identity({
          retry: {
            attempt: 2,
            retryOfObservationId: terminal.observationId,
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "BOUNDARY_RETRY_LINEAGE_INVALID" });
    expect(calls).toBe(1);
  });

  it("returns an already committed identical attempt without reinvoking", async () => {
    const { ledger } = await createLedger();
    let calls = 0;
    const options = {
      ledger,
      identity: identity(),
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => {
        calls += 1;
        return { id: "effect" };
      },
      classify: () => ({
        acceptance: "accepted" as const,
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect" }),
      verifyReadback: () => true,
    };
    const first = await observeProductionBoundary(options);
    const replay = await observeProductionBoundary(options);
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
  });

  it("singleflights concurrent identical attempts through invoke and append", async () => {
    const { ledger } = await createLedger();
    let calls = 0;
    let enterInvoke: () => void = () => undefined;
    const invokeEntered = new Promise<void>((resolve) => {
      enterInvoke = resolve;
    });
    let releaseInvoke: () => void = () => undefined;
    const invokeReleased = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });
    const options = {
      ledger,
      identity: identity(),
      payload: { text: "payload" },
      now: clock(
        "2026-08-21T12:00:00.000Z",
        "2026-08-21T12:00:01.000Z",
        "2026-08-21T12:00:02.000Z",
      ),
      generationFence: generationFence(),
      invoke: async () => {
        calls += 1;
        enterInvoke();
        await invokeReleased;
        return { id: "effect" };
      },
      classify: () => ({
        acceptance: "accepted" as const,
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect" }),
      verifyReadback: () => true,
    };
    const firstPromise = observeProductionBoundary(options);
    await invokeEntered;
    const concurrentPromise = observeProductionBoundary(options);
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseInvoke();
    const [first, concurrent] = await Promise.all([
      firstPromise,
      concurrentPromise,
    ]);
    expect(concurrent).toEqual(first);
    expect(calls).toBe(1);
    await expect(ledger.readAll()).resolves.toEqual([first]);
  });

  it("reconciles an exact receipt after a post-commit durability error", async () => {
    const { path } = await createLedger();
    const ledger = new JsonlBoundaryObservationLedger(path, {
      afterFileSync: async () => {
        const error = new Error(
          "directory sync unsupported",
        ) as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        throw error;
      },
    });
    const observation = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => ({ id: "effect" }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect" }),
      verifyReadback: () => true,
    });
    expect(observation.result).toBe("succeeded");
    await expect(
      new JsonlBoundaryObservationLedger(path).readAll(),
    ).resolves.toEqual([observation]);
  });

  it("fails closed on a forged success and a truncated restart frame", async () => {
    const { ledger, path } = await createLedger();
    const observation = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => ({ accepted: true, id: "effect-1" }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect-1" }),
      verifyReadback: (response, readback) => response.id === readback.id,
    });
    const forged = JSON.parse(JSON.stringify(observation)) as Record<
      string,
      unknown
    >;
    delete forged.readbackSha256;
    const { recordSha256: _recordSha256, ...forgedWithoutHash } = forged;
    forged.recordSha256 = canonicalSha256(
      forgedWithoutHash,
      "boundaryObservationRecord",
    );
    await writeFile(path, `${JSON.stringify(forged)}\n`, "utf8");
    await expect(
      new JsonlBoundaryObservationLedger(path).readAll(),
    ).rejects.toMatchObject({ code: "BOUNDARY_LEDGER_CORRUPT" });

    const missingRequired = JSON.parse(JSON.stringify(observation)) as Record<
      string,
      unknown
    >;
    delete missingRequired.target;
    const { recordSha256: _missingHash, ...missingRequiredWithoutHash } =
      missingRequired;
    missingRequired.recordSha256 = canonicalSha256(
      missingRequiredWithoutHash,
      "boundaryObservationRecord",
    );
    await writeFile(path, `${JSON.stringify(missingRequired)}\n`, "utf8");
    await expect(
      new JsonlBoundaryObservationLedger(path).readAll(),
    ).rejects.toMatchObject({ code: "BOUNDARY_LEDGER_CORRUPT" });

    await writeFile(path, JSON.stringify(observation).slice(0, -8), "utf8");
    await expect(
      new JsonlBoundaryObservationLedger(path).readAll(),
    ).rejects.toMatchObject({ code: "BOUNDARY_LEDGER_CORRUPT" });
  });

  it("documents that an unsealed chain cannot detect full rewrites or tail deletion", async () => {
    const { ledger, path } = await createLedger();
    const options = {
      ledger,
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => ({ id: "effect" }),
      classify: () => ({
        acceptance: "accepted" as const,
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect" }),
      verifyReadback: () => true,
    };
    const first = await observeProductionBoundary({
      ...options,
      identity: identity(),
    });
    await observeProductionBoundary({
      ...options,
      identity: identity({ idempotencyKey: "task-2:2026-08-21T12:00:00.000Z" }),
    });

    await writeFile(path, `${JSON.stringify(first)}\n`, "utf8");
    await expect(
      new JsonlBoundaryObservationLedger(path).readAll(),
    ).resolves.toEqual([first]);

    const rewritten = { ...first, resultCode: "rewritten-history" };
    const { recordSha256: _oldHash, ...rewrittenWithoutHash } = rewritten;
    rewritten.recordSha256 = canonicalSha256(
      rewrittenWithoutHash,
      "boundaryObservationRecord",
    );
    await writeFile(path, `${JSON.stringify(rewritten)}\n`, "utf8");
    await expect(
      new JsonlBoundaryObservationLedger(path).readAll(),
    ).resolves.toEqual([rewritten]);
  });

  it("records classifier and verifier exceptions as sanitized non-success", async () => {
    const { ledger } = await createLedger();
    const common = {
      ledger,
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => ({ id: "effect" }),
      readback: async () => ({ id: "effect" }),
    };
    const classified = await observeProductionBoundary({
      ...common,
      identity: identity(),
      classify: () => {
        throw new Error("classifier token=secret");
      },
      verifyReadback: () => true,
      redactText: (text) => text.replace("secret", REDACTED_TEST),
    });
    expect(classified).toMatchObject({
      boundaryCalled: true,
      result: "unknown",
      resultCode: "classifier_threw",
    });
    expect(JSON.stringify(classified)).not.toContain("secret");

    const verified = await observeProductionBoundary({
      ...common,
      identity: identity({
        idempotencyKey: "task-2:2026-08-21T12:00:00.000Z",
      }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      verifyReadback: () => {
        throw new Error("verifier token=secret");
      },
      redactText: (text) => text.replace("secret", REDACTED_TEST),
    });
    expect(verified).toMatchObject({
      boundaryCalled: true,
      result: "unknown",
    });
    expect(JSON.stringify(verified)).not.toContain("secret");

    const hostileThrownValue = {
      [Symbol.toPrimitive]() {
        throw new Error("hostile coercion");
      },
    };
    const hostile = await observeProductionBoundary({
      ...common,
      identity: identity({
        idempotencyKey: "task-3:2026-08-21T12:00:00.000Z",
      }),
      classify: () => {
        throw hostileThrownValue;
      },
      verifyReadback: () => true,
    });
    expect(hostile).toMatchObject({
      boundaryCalled: true,
      result: "unknown",
      resultCode: "classifier_threw",
      error: {
        name: "Error",
        message: "unavailable thrown value",
      },
    });
  });

  it("translates a runtime-invalid classifier return into a durable unknown attempt", async () => {
    const { ledger } = await createLedger();
    const observation = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(),
      invoke: async () => ({ id: "effect" }),
      classify: () =>
        ({
          acceptance: "fabricated",
          code: "",
          retryable: "yes",
        }) as unknown as BoundaryResultClassification,
      readback: async () => ({ id: "effect" }),
      verifyReadback: () => true,
    });

    expect(observation).toMatchObject({
      boundaryCalled: true,
      acceptance: "unknown",
      result: "unknown",
      resultCode: "classifier_threw",
    });
    const acceptedRetryable = await observeProductionBoundary({
      ledger,
      identity: identity({
        idempotencyKey: "task-2:2026-08-21T12:00:00.000Z",
      }),
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:01.000Z"),
      generationFence: generationFence(),
      invoke: async () => ({ id: "effect-2" }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: true,
      }),
      readback: async () => ({ id: "effect-2" }),
      verifyReadback: () => true,
    });
    expect(acceptedRetryable).toMatchObject({
      boundaryCalled: true,
      acceptance: "unknown",
      result: "unknown",
      resultCode: "classifier_threw",
    });
    await expect(ledger.readAll()).resolves.toEqual([
      observation,
      acceptedRetryable,
    ]);
  });

  it("records post-invocation generation revalidation failure and staleness", async () => {
    const { ledger } = await createLedger();
    let guardCalls = 0;
    const failed = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: {
        withGeneration: async (_expected, operation) =>
          operation({
            isCurrent: async () => {
              guardCalls += 1;
              if (guardCalls === 2) {
                throw new Error("generation token=secret");
              }
              return true;
            },
          }),
      },
      invoke: async () => ({ id: "effect-1" }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect-1" }),
      verifyReadback: () => true,
      redactText: (text) => text.replace("secret", REDACTED_TEST),
    });
    expect(failed).toMatchObject({
      boundaryCalled: true,
      acceptance: "unknown",
      result: "unknown",
      resultCode: "generation_revalidation_threw",
    });
    expect(JSON.stringify(failed)).not.toContain("secret");

    let generation = "generation-7";
    const stale = await observeProductionBoundary({
      ledger,
      identity: identity({
        idempotencyKey: "task-2:2026-08-21T12:01:00.000Z",
      }),
      payload: { value: 2 },
      now: clock("2026-08-21T12:01:00.000Z"),
      generationFence: generationFence(() => generation),
      invoke: async () => {
        generation = "generation-8";
        return { id: "effect-2" };
      },
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect-2" }),
      verifyReadback: () => true,
    });
    expect(stale).toMatchObject({
      boundaryCalled: true,
      acceptance: "unknown",
      result: "stale_completion",
      resultCode: "stale_generation_after_invoke",
    });
  });

  it.each(["response", "readback"] as const)(
    "records cyclic %s evidence as a durable unknown attempt",
    async (stage) => {
      const { ledger } = await createLedger();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const observation = await observeProductionBoundary({
        ledger,
        identity: identity(),
        payload: { value: 1 },
        now: clock("2026-08-21T12:00:00.000Z"),
        generationFence: generationFence(),
        invoke: async () => (stage === "response" ? cyclic : { id: "effect" }),
        classify: () => ({
          acceptance: "accepted",
          code: "accepted",
          retryable: false,
        }),
        readback: async () =>
          stage === "readback" ? cyclic : { id: "effect" },
        verifyReadback: () => true,
      });

      expect(observation).toMatchObject({
        boundaryCalled: true,
        acceptance: "unknown",
        result: "unknown",
        resultCode:
          stage === "response"
            ? "response_evidence_threw"
            : "readback_evidence_threw",
      });
      expect(observation.error?.message).toContain("cycle");
      await expect(ledger.readAll()).resolves.toEqual([observation]);
    },
  );

  it("holds the generation fence through durable receipt append before rollover", async () => {
    const { ledger } = await createLedger();
    const generation = exclusiveGenerationFence("generation-7");
    let enterInvoke: () => void = () => undefined;
    const invokeEntered = new Promise<void>((resolve) => {
      enterInvoke = resolve;
    });
    let releaseInvoke: () => void = () => undefined;
    const invokeReleased = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });
    const observationPromise = observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generation.fence,
      invoke: async () => {
        enterInvoke();
        await invokeReleased;
        return { id: "effect" };
      },
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "effect" }),
      verifyReadback: (response, readback) => response.id === readback.id,
    });
    await invokeEntered;
    let rolloverSettled = false;
    const rolloverPromise = generation.rollover("generation-8").finally(() => {
      rolloverSettled = true;
    });
    await Promise.resolve();
    expect(rolloverSettled).toBe(false);

    releaseInvoke();
    const observation = await observationPromise;
    await rolloverPromise;
    expect(observation.result).toBe("succeeded");
    await expect(ledger.readAll()).resolves.toEqual([observation]);
  });

  it("does not invoke or append when generation-fence acquisition fails", async () => {
    const { ledger } = await createLedger();
    let calls = 0;
    await expect(
      observeProductionBoundary({
        ledger,
        identity: identity(),
        payload: { value: 1 },
        now: clock("2026-08-21T12:00:00.000Z"),
        generationFence: {
          withGeneration: async () => {
            throw new Error("lease backend unavailable");
          },
        },
        invoke: async () => {
          calls += 1;
          return { id: "effect" };
        },
        classify: () => ({
          acceptance: "accepted",
          code: "accepted",
          retryable: false,
        }),
        readback: async () => ({ id: "effect" }),
        verifyReadback: () => true,
      }),
    ).rejects.toMatchObject({
      code: "BOUNDARY_GENERATION_FENCE_FAILED",
      cause: expect.objectContaining({ message: "lease backend unavailable" }),
    });
    expect(calls).toBe(0);
    await expect(ledger.readAll()).resolves.toEqual([]);
  });

  it.each([
    ["retryable_failure", "rejected", false],
    ["permanent_failure", "rejected", false],
    ["rate_limit", "rate_limited", false],
    ["partial_failure", "partial_failure", true],
    ["ambiguous_dispatch", "unknown", true],
    ["stale_completion", "stale_completion", true],
  ] as const)(
    "records the %s fault without fabricating success",
    async (kind, expectedResult, shouldCall) => {
      const { ledger } = await createLedger();
      let calls = 0;
      const fault: BoundaryFaultDirective = {
        kind,
        message: `scripted ${kind} token=secret-token`,
        retryAfterMs: kind === "rate_limit" ? 30_000 : undefined,
      };
      const observation = await observeProductionBoundary({
        ledger,
        identity: identity(),
        payload: { password: "secret-password" },
        now: clock("2026-08-21T12:00:00.000Z"),
        generationFence: generationFence(),
        invoke: async () => {
          calls += 1;
          return { accepted: true, id: "effect-1" };
        },
        classify: () => ({
          acceptance: "accepted",
          code: "accepted",
          retryable: false,
        }),
        readback: async () => ({ id: "effect-1" }),
        verifyReadback: (response, readback) => response.id === readback.id,
        fault,
        redactText: (text) => text.replace("secret-token", REDACTED_TEST),
      });
      expect(observation.result).toBe(expectedResult);
      expect(observation.boundaryCalled).toBe(shouldCall);
      expect(calls).toBe(shouldCall ? 1 : 0);
      expect(JSON.stringify(observation)).not.toContain("secret-token");
      expect(JSON.stringify(observation)).not.toContain("secret-password");
    },
  );

  it("rejects an old generation before the real call and preserves prior records across restart", async () => {
    const { ledger, path } = await createLedger();
    let generation = "generation-7";
    const first = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:00.000Z"),
      generationFence: generationFence(() => generation),
      invoke: async () => {
        return { accepted: true, id: "old-effect" };
      },
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "old-effect" }),
      verifyReadback: (response, readback) => response.id === readback.id,
    });
    expect(first).toMatchObject({
      result: "succeeded",
      boundaryCalled: true,
    });

    generation = "generation-8";
    let staleCalls = 0;
    const stale = await observeProductionBoundary({
      ledger,
      identity: identity({
        idempotencyKey: "task-stale:2026-08-21T12:00:30.000Z",
      }),
      payload: { value: "stale" },
      now: clock("2026-08-21T12:00:30.000Z"),
      generationFence: generationFence(() => generation),
      invoke: async () => {
        staleCalls += 1;
        return { accepted: true, id: "forbidden-effect" };
      },
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "forbidden-effect" }),
      verifyReadback: (response, readback) => response.id === readback.id,
    });
    expect(stale).toMatchObject({
      order: 2,
      result: "stale_completion",
      boundaryCalled: false,
    });
    expect(staleCalls).toBe(0);

    const restarted = new JsonlBoundaryObservationLedger(path);
    expect(await restarted.readAll()).toEqual([first, stale]);
    const second = await observeProductionBoundary({
      ledger: restarted,
      identity: identity({
        generation: "generation-8",
        retry: { attempt: 1 },
      }),
      payload: { value: 2 },
      now: clock("2026-08-21T12:01:00.000Z"),
      generationFence: generationFence(() => generation),
      invoke: async () => ({ accepted: true, id: "new-effect" }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "new-effect" }),
      verifyReadback: (response, readback) => response.id === readback.id,
    });
    expect(second).toMatchObject({ order: 3, result: "succeeded" });
    expect(
      (await restarted.readAll()).map((entry) => entry.generation),
    ).toEqual(["generation-7", "generation-7", "generation-8"]);
  });
});

const REDACTED_TEST = "[REDACTED]";
