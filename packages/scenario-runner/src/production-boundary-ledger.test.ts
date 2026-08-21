/**
 * Proves the durable observation ledger against the production scheduling
 * connector adapter, including typed DispatchResult classification, canonical
 * readback, injected clock timestamps, restart continuity, redaction, and every
 * supported synthetic boundary fault.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IAgentRuntime } from "@elizaos/core";
import type { DispatchResult } from "@elizaos/plugin-scheduling";
import { dispatchViaMessageConnector } from "@elizaos/plugin-scheduling/scheduled-task/connector-dispatch";
import type { ScheduledTaskDispatchRecord } from "@elizaos/plugin-scheduling/scheduled-task/runner";
import { afterEach, describe, expect, it } from "vitest";

import {
  type BoundaryFaultDirective,
  JsonlBoundaryObservationLedger,
  observeProductionBoundary,
  type ProductionBoundaryIdentity,
} from "./production-boundary-ledger.ts";

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
      activeGeneration: () => "generation-7",
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

  it("cannot record success when the adapter was not called or readback is absent/mismatched", async () => {
    const { ledger } = await createLedger();
    let calls = 0;
    const common = {
      ledger,
      payload: { text: "payload" },
      now: clock("2026-08-21T12:00:00.000Z"),
      activeGeneration: () => "generation-7",
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
        retry: { attempt: 3, retryOfObservationId: missing.observationId },
      }),
      readback: async () => ({ id: "different-effect" }),
    });
    expect(mismatch.result).toBe("readback_mismatch");
    expect((await ledger.readAll()).map((entry) => entry.order)).toEqual([
      1, 2, 3,
    ]);
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
        activeGeneration: () => "generation-7",
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

  it("rejects an old generation after the real call and preserves prior records across restart", async () => {
    const { ledger, path } = await createLedger();
    let generation = "generation-7";
    const first = await observeProductionBoundary({
      ledger,
      identity: identity(),
      payload: { value: 1 },
      now: clock("2026-08-21T12:00:00.000Z"),
      activeGeneration: () => generation,
      invoke: async () => {
        generation = "generation-8";
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
    expect(first.result).toBe("stale_completion");

    const restarted = new JsonlBoundaryObservationLedger(path);
    expect(await restarted.readAll()).toEqual([first]);
    const second = await observeProductionBoundary({
      ledger: restarted,
      identity: identity({
        generation: "generation-8",
        retry: { attempt: 1 },
      }),
      payload: { value: 2 },
      now: clock("2026-08-21T12:01:00.000Z"),
      activeGeneration: () => generation,
      invoke: async () => ({ accepted: true, id: "new-effect" }),
      classify: () => ({
        acceptance: "accepted",
        code: "accepted",
        retryable: false,
      }),
      readback: async () => ({ id: "new-effect" }),
      verifyReadback: (response, readback) => response.id === readback.id,
    });
    expect(second).toMatchObject({ order: 2, result: "succeeded" });
    expect(
      (await restarted.readAll()).map((entry) => entry.generation),
    ).toEqual(["generation-7", "generation-8"]);
  });
});

const REDACTED_TEST = "[REDACTED]";
