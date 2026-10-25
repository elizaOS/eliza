/**
 * Shared logic for the orchestrator Reflexion re-spawn scenario (#8899).
 *
 * The reflexion loop is internal: when an automatic verification fails the
 * OrchestratorTaskService writes a verbal post-mortem onto the task
 * (`metadata.attemptReflections`), and the NEXT `spawnAgentForTask` reads those
 * post-mortems back and injects them into the new sub-agent's goal prompt so a
 * retry does not repeat the same gap. To exercise that end to end
 * deterministically (no real coding-agent subprocess), this driver:
 *
 *   1. constructs the real OrchestratorTaskService over an in-memory store,
 *   2. injects a scripted ACP whose `spawnSession` captures the goal prompt that
 *      was actually sent to each spawned sub-agent, and
 *   3. routes the verifier's `useModel` call to an injected model (the live
 *      model under the `.scenario.ts`, or a deterministic stub under
 *      `orchestrator-scenario-logic.test.ts`).
 *
 * It reuses the grilling harness's runtime proxy + task seeding so the verifier
 * path is identical to the other orchestrator scenarios; only the ACP gains a
 * spawn capture.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { OrchestratorTaskService } from "../../../src/services/orchestrator-task-service";
import { OrchestratorTaskStore } from "../../../src/services/orchestrator-task-store";
import type { AttemptReflection } from "../../../src/services/orchestrator-task-types";
import type { SpawnOptions, SpawnResult } from "../../../src/services/types";
import { makeGrillingRuntime, waitFor } from "./orchestrator-grilling-harness";

type VerifierModel = (...args: unknown[]) => Promise<unknown>;

/** Distinctive verdict text the re-spawn prompt must carry back so the check is
 * unambiguous: a generic "tests pass" would collide with the acceptance
 * criterion. */
export const REFLEXION_FAIL_SUMMARY = "tests were never run";
export const REFLEXION_MISSING_CRITERION = "unit tests pass";

/** A deterministic verifier stand-in that FAILS any completion lacking pasted
 * passing-test output — the same discrimination the live judge makes — and
 * reports the distinctive {@link REFLEXION_FAIL_SUMMARY}. Used by the keyless
 * lane; the `.scenario.ts` can swap in a live model. */
export const reflexionVerifierModel: VerifierModel = async (
  ..._args: unknown[]
) => {
  const opts = _args[1] as { prompt?: string } | undefined;
  const prompt = opts?.prompt ?? "";
  const hasPassingTests =
    /\d+\s+passing|tests?\s+pass(ed)?\b.*\d|0\s+fail/i.test(prompt);
  return JSON.stringify(
    hasPassingTests
      ? { passed: true, summary: "all criteria proven", missing: [] }
      : {
          passed: false,
          summary: REFLEXION_FAIL_SUMMARY,
          missing: [REFLEXION_MISSING_CRITERION],
        },
  );
};

/** A scripted ACP that records the goal prompt + session metadata handed to
 * each spawned session and lets the driver emit `task_complete` events. */
export function makeSpawnCapturingAcp() {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  let counter = 0;
  const sent: Array<{ sessionId: string; text: string }> = [];
  const spawns: Array<{
    sessionId: string;
    initialTask: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const service = {
    onSessionEvent(
      cb: (sessionId: string, event: string, data: unknown) => void,
    ) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    sendToSession: async (sessionId: string, text: string) => {
      sent.push({ sessionId, text });
      return { stopReason: "end_turn", finalText: "ok" };
    },
    stopSession: async () => undefined,
    getChangedPaths: () => [],
    getSession: async () => undefined,
    updateSessionMetadata: async () => undefined,
    spawnSession: async (opts: SpawnOptions): Promise<SpawnResult> => {
      counter += 1;
      const sessionId = `reflexion-spawn-${counter}`;
      spawns.push({
        sessionId,
        initialTask: opts.initialTask ?? "",
        metadata: opts.metadata,
      });
      return {
        sessionId,
        id: sessionId,
        name: opts.name ?? `reflexion-${counter}`,
        agentType: opts.agentType ?? "opencode",
        workdir: opts.workdir ?? "/tmp/reflexion",
        status: "ready",
        metadata: { ...(opts.metadata ?? {}) },
      };
    },
  };
  return {
    service,
    sent,
    spawns,
    emit: (sessionId: string, event: string, data: unknown) =>
      handler?.(sessionId, event, data),
  };
}

/** Seed a fresh in-memory task (status `open`, no pre-attached session) so the
 * spawn → fail → re-spawn flow runs entirely through the real service. */
export async function seedReflexionTask(acceptanceCriteria: string[]): Promise<{
  store: OrchestratorTaskStore;
  taskId: string;
}> {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const detail = await store.createTask({
    title: "Implement the parser",
    goal: "implement the parser and prove the tests pass",
    acceptanceCriteria,
    roomId: "scenario-room-reflexion",
    taskRoomId: "scenario-task-room-reflexion",
    worldId: "scenario-world",
  });
  return { store, taskId: detail.task.id };
}

export interface ReflexionRespawnTrace {
  store: OrchestratorTaskStore;
  taskId: string;
  /** Goal prompt of the FIRST spawn — before any failure (no reflections). */
  firstPrompt: string;
  /** Goal prompt of the SECOND spawn — after one failed verification. */
  respawnPrompt: string;
  /** The re-spawned session's persisted `goalPrompt` (DB round-trip). */
  persistedRespawnGoalPrompt: string;
  /** Reflections persisted after the failed verification. */
  reflectionsAfterFail: AttemptReflection[];
}

/**
 * Drive the genuine pipeline: spawn → report complete with no proof → automatic
 * verification fails and persists a reflection → re-spawn reads + injects it.
 * Returns the captured prompts so callers can assert / dump them.
 */
export async function driveReflexionRespawn(
  baseRuntime: IAgentRuntime,
  verifierModel: VerifierModel,
): Promise<ReflexionRespawnTrace> {
  const { store, taskId } = await seedReflexionTask([
    REFLEXION_MISSING_CRITERION,
  ]);
  const acp = makeSpawnCapturingAcp();
  const runtime = makeGrillingRuntime(baseRuntime, acp.service, verifierModel);
  const service = new OrchestratorTaskService(runtime, { store });
  await service.start();
  try {
    // First spawn — clean prompt, no past failures.
    await service.spawnAgentForTask(taskId);
    const firstSpawn = acp.spawns.at(0);
    if (!firstSpawn) throw new Error("expected a first spawned session");

    // The sub-agent reports complete with no pasted evidence → verification
    // fails and the real append writes attempt-1's post-mortem.
    acp.emit(firstSpawn.sessionId, "task_complete", {
      response: "I implemented the parser and I believe it works.",
    });
    const failed = await waitFor(async () => {
      const doc = await store.getTask(taskId);
      const reflections = doc?.task.metadata?.attemptReflections;
      return Array.isArray(reflections) && reflections.length > 0;
    });
    if (!failed) {
      throw new Error(
        "verification never persisted a reflection after failure",
      );
    }

    // Re-spawn — the new prompt must replay attempt-1's reflection.
    await service.spawnAgentForTask(taskId);
    const respawn = acp.spawns.at(1);
    if (!respawn) throw new Error("expected a re-spawned session");

    const doc = await store.getTask(taskId);
    const reflectionsAfterFail = (doc?.task.metadata?.attemptReflections ??
      []) as AttemptReflection[];
    const persisted = doc?.sessions.find(
      (session) => session.sessionId === respawn.sessionId,
    );

    return {
      store,
      taskId,
      firstPrompt: firstSpawn.initialTask,
      respawnPrompt: respawn.initialTask,
      persistedRespawnGoalPrompt: persisted?.goalPrompt ?? "",
      reflectionsAfterFail,
    };
  } finally {
    await service.stop().catch(() => undefined);
  }
}

/**
 * Scenario check (returns `undefined` on success, else a failure string): a
 * failed verification followed by a re-spawn carries the first attempt's
 * reflection into the second goal prompt, and the clean first prompt does not.
 */
export async function runReflexionRespawnCheck(
  baseRuntime: IAgentRuntime,
  verifierModel: VerifierModel,
): Promise<string | undefined> {
  const trace = await driveReflexionRespawn(baseRuntime, verifierModel);

  if (trace.firstPrompt.includes("Past Attempt Failures")) {
    return `the clean first spawn prompt must not carry a reflection:\n${trace.firstPrompt.slice(0, 400)}`;
  }
  const expectedLine = `Attempt 1: ${REFLEXION_FAIL_SUMMARY}`;
  const expectedMissing = `Missing: ${REFLEXION_MISSING_CRITERION}.`;
  for (const [label, prompt] of [
    ["re-spawn prompt", trace.respawnPrompt],
    ["persisted re-spawn goalPrompt", trace.persistedRespawnGoalPrompt],
  ] as const) {
    if (!prompt.includes("--- Past Attempt Failures ---")) {
      return `${label} missing the Past Attempt Failures section:\n${prompt.slice(0, 500)}`;
    }
    if (!prompt.includes(expectedLine)) {
      return `${label} missing "${expectedLine}":\n${prompt.slice(0, 500)}`;
    }
    if (!prompt.includes(expectedMissing)) {
      return `${label} missing "${expectedMissing}":\n${prompt.slice(0, 500)}`;
    }
  }
  if (trace.reflectionsAfterFail.length !== 1) {
    return `expected exactly one persisted reflection, saw ${trace.reflectionsAfterFail.length}`;
  }
  return undefined;
}
