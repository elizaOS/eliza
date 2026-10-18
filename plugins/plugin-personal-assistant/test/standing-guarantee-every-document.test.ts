/**
 * A standing guarantee ("always track contract renewals") must cover every
 * later document of its class. Its event task leaves `scheduled` when the
 * first document fires it, and the guarantee must still apply to the next
 * ones. Real scheduled-task runner (in-memory store) and real event bridge.
 */
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  fireEventTriggeredTasks,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  TestNoopScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling";
import { expect, it } from "vitest";
import {
  applyCommitmentClassGuarantees,
  installCommitmentClassGuarantee,
} from "../src/lifeops/commitments/index.js";

function harness() {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  let next = 0;
  const runner = createScheduledTaskRunner({
    agentId: "agent",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => `task_${++next}`,
    now: () => new Date(),
  } as never);
  const runtime = {
    agentId: "agent",
    getService: () => ({ getRunner: () => runner }),
    emitEvent: async (eventKind: string, payload: Record<string, unknown>) => {
      const { runtime: _runtime, ...data } = payload;
      await fireEventTriggeredTasks({ runner, eventKind, payload: data });
    },
  };
  return { runner, runtime: runtime as never };
}

const renewal = (documentId: string) => ({
  documentId,
  title: `Contract ${documentId}`,
  deadline: new Date(Date.now() + 200 * 86_400_000).toISOString(),
  obligationKind: "renewal" as const,
});

it("adds the warning watcher for every later document of the class", async () => {
  const { runner, runtime } = harness();
  const guarantee = await installCommitmentClassGuarantee(runtime, {
    agentId: "agent",
    obligationClass: "renewal",
  });

  const first = await applyCommitmentClassGuarantees(runtime, {
    agentId: "agent",
    artifact: renewal("doc-1"),
  });
  expect(first.warnTaskIds).toHaveLength(1);
  // The first document fired the guarantee's event task.
  const fired = (await runner.list({})).find(
    (task) => task.taskId === guarantee.taskId,
  );
  expect(fired?.state.status).not.toBe("scheduled");

  for (const documentId of ["doc-2", "doc-3"]) {
    const later = await applyCommitmentClassGuarantees(runtime, {
      agentId: "agent",
      artifact: renewal(documentId),
    });
    expect(later.matchedGuaranteeTaskIds, documentId).toEqual([
      guarantee.taskId,
    ]);
    expect(later.warnTaskIds, documentId).toHaveLength(1);
  }
});
