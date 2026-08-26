/**
 * Lane-scoped acceptance criteria (live 2026-08-24, tip-calc + word-counter,
 * store b850bc30): the two-lane ask minted task-level criteria naming BOTH
 * deliverables, the word-counter lane's verify + rebuild briefs carried the
 * umbrella set, and the coached builder rewrote the word-counter page into a
 * combined page — contradicting the sibling lane's verdict. These tests pin
 * the fix: a lane's criteria, verify inputs, and retry brief are generated
 * from THAT lane's slice only; the sibling lane stays untouched. Real service
 * + memory store; the only stub is the criteria-refinement model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CRITERIA_TEMPLATES,
  generateDefaultAcceptanceCriteria,
} from "../services/acceptance-criteria.js";
import { AcpService } from "../services/acp-service.js";
import { buildGoalFollowUp } from "../services/goal-prompt.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

const UMBRELLA_REQUEST =
  "make me a tip calculator page and deploy a word counter page";
const UMBRELLA_GOAL = "Tip calculator page and word counter page";
const UMBRELLA_CRITERIA = [
  "the live URL is reachable",
  "the deliverable file exists in the workdir",
  "the page shows a tip calculator",
  "the page shows a word counter",
];
const TIP_LANE_TASK = "Build a tip calculator page";
const WORD_LANE_TASK = "Build a word counter page";

/** Criteria-refinement stub: answers each lane's constrained app-build prompt
 * with that lane's own content specific, the way the live TEXT_SMALL call
 * produced "the page shows a tip calculator" for the umbrella. */
function makeLaneModel() {
  const prompts: string[] = [];
  const useModel = vi.fn(async (_type: unknown, params: unknown) => {
    const prompt = String((params as { prompt?: unknown })?.prompt ?? "");
    prompts.push(prompt);
    if (/word counter/i.test(prompt)) {
      return '{"criteria":["the page shows a word counter"]}';
    }
    if (/tip calculator/i.test(prompt)) {
      return '{"criteria":["the page shows a tip calculator"]}';
    }
    return '{"criteria":[]}';
  });
  return { prompts, useModel };
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: () => undefined,
    ...overrides,
  };
}

async function addLane(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId: string,
  part: string,
  task: string,
): Promise<void> {
  const now = Date.now();
  await store.addSession({
    id: `row-${sessionId}`,
    taskId,
    sessionId,
    framework: "eliza-code",
    label: task,
    originalTask: `--- User Task ---\n${task}\n\n--- Rooms ---\nx`,
    workdir: `/tmp/apps/${sessionId}`,
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: { requestVoicePart: part },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
}

/** The two-lane live shape: one task record, umbrella generated criteria,
 * one `part:N` session per lane. */
async function seedTwoLaneTask(store: OrchestratorTaskStore): Promise<string> {
  const detail = await store.createTask({
    title: UMBRELLA_GOAL,
    goal: UMBRELLA_GOAL,
    originalRequest: UMBRELLA_REQUEST,
    acceptanceCriteria: [...UMBRELLA_CRITERIA],
    metadata: { acceptanceCriteriaOrigin: "generated" },
  });
  const taskId = detail.task.id;
  await addLane(store, taskId, "tip", "part:0", TIP_LANE_TASK);
  await addLane(store, taskId, "word", "part:1", WORD_LANE_TASK);
  return taskId;
}

/** The Acceptance Criteria section of a goal-envelope brief. */
function criteriaSection(brief: string): string {
  const at = brief.indexOf("--- Acceptance Criteria ---");
  expect(at).toBeGreaterThanOrEqual(0);
  const after = brief.slice(at + "--- Acceptance Criteria ---".length);
  const next = after.search(/^--- .+? ---$/m);
  return next >= 0 ? after.slice(0, next) : after;
}

type LaneCriteriaService = {
  laneScopedAcceptanceCriteria(
    doc: unknown,
    sessionId: string,
  ): Promise<string[]>;
};

describe("generateDefaultAcceptanceCriteria lane input", () => {
  it("reads ONLY the lane slice when laneTask is given — the umbrella verbatim never reaches the refiner", async () => {
    const { prompts, useModel } = makeLaneModel();
    const criteria = await generateDefaultAcceptanceCriteria(
      UMBRELLA_GOAL,
      undefined,
      makeRuntime({ useModel }) as never,
      { verbatimRequest: UMBRELLA_REQUEST, laneTask: WORD_LANE_TASK },
    );
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/tip calculator/i);
      expect(prompt).toContain(WORD_LANE_TASK);
    }
    expect(criteria).toContain("the page shows a word counter");
    expect(criteria.join("\n")).not.toMatch(/tip calculator/i);
  });

  it("classifies from the lane slice, not the umbrella (deploy phrasing in the umbrella must not mint deploy criteria on a page lane)", async () => {
    const criteria = await generateDefaultAcceptanceCriteria(
      UMBRELLA_REQUEST,
      undefined,
      undefined,
      { laneTask: WORD_LANE_TASK },
    );
    expect(criteria).toEqual([...DEFAULT_CRITERIA_TEMPLATES["app-build"]]);
  });
});

describe("laneScopedAcceptanceCriteria (two-lane live shape)", () => {
  it("scopes the word-counter lane to word-counter items only, caches per part, and leaves the tip-calc lane untouched", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { useModel } = makeLaneModel();
    const runtime = makeRuntime({ useModel });
    const service = new OrchestratorTaskService(runtime as never, { store });
    const taskId = await seedTwoLaneTask(store);
    const doc = await store.getTask(taskId);

    const wordCriteria = await (
      service as unknown as LaneCriteriaService
    ).laneScopedAcceptanceCriteria(doc, "word");
    expect(wordCriteria).toContain("the page shows a word counter");
    expect(wordCriteria.join("\n")).not.toMatch(/tip calculator/i);

    const tipCriteria = await (
      service as unknown as LaneCriteriaService
    ).laneScopedAcceptanceCriteria(await store.getTask(taskId), "tip");
    expect(tipCriteria).toContain("the page shows a tip calculator");
    expect(tipCriteria.join("\n")).not.toMatch(/word counter/i);

    // Per-part cache stamped; the next lap reuses it without model spend.
    const stamped = await store.getTask(taskId);
    expect(stamped?.task.metadata?.laneAcceptanceCriteria).toEqual({
      "part:1": wordCriteria,
      "part:0": tipCriteria,
    });
    const callsBefore = useModel.mock.calls.length;
    const cached = await (
      service as unknown as LaneCriteriaService
    ).laneScopedAcceptanceCriteria(stamped, "word");
    expect(cached).toEqual(wordCriteria);
    expect(useModel.mock.calls.length).toBe(callsBefore);
  });

  it("returns the umbrella unchanged for a caller-supplied contract and for single-lane tasks", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { useModel } = makeLaneModel();
    const service = new OrchestratorTaskService(
      makeRuntime({ useModel }) as never,
      { store },
    );

    const callerDetail = await store.createTask({
      title: UMBRELLA_GOAL,
      goal: UMBRELLA_GOAL,
      acceptanceCriteria: [...UMBRELLA_CRITERIA],
      metadata: { acceptanceCriteriaOrigin: "caller" },
    });
    await addLane(store, callerDetail.task.id, "tip", "part:0", TIP_LANE_TASK);
    await addLane(
      store,
      callerDetail.task.id,
      "word",
      "part:1",
      WORD_LANE_TASK,
    );
    const callerCriteria = await (
      service as unknown as LaneCriteriaService
    ).laneScopedAcceptanceCriteria(
      await store.getTask(callerDetail.task.id),
      "word",
    );
    expect(callerCriteria).toEqual(UMBRELLA_CRITERIA);

    const singleDetail = await store.createTask({
      title: "t",
      goal: "g",
      acceptanceCriteria: [...UMBRELLA_CRITERIA],
      metadata: { acceptanceCriteriaOrigin: "generated" },
    });
    await addLane(store, singleDetail.task.id, "only", "part:0", "Build it");
    const singleCriteria = await (
      service as unknown as LaneCriteriaService
    ).laneScopedAcceptanceCriteria(
      await store.getTask(singleDetail.task.id),
      "only",
    );
    expect(singleCriteria).toEqual(UMBRELLA_CRITERIA);
    expect(useModel).not.toHaveBeenCalled();
  });
});

describe("lane retry brief (sendToTaskAgent)", () => {
  it("rebuild brief for the word-counter lane carries lane scope + lane criteria and never the umbrella contract", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { useModel } = makeLaneModel();
    const sent: Array<{ sessionId: string; text: string }> = [];
    const fakeAcp = {
      sendToSession: vi.fn(async (sessionId: string, text: string) => {
        sent.push({ sessionId, text });
        return { stopReason: "end_turn", finalText: "ok" };
      }),
    };
    const runtime = makeRuntime({
      useModel,
      getService: (type: string) =>
        type === AcpService.serviceType ? fakeAcp : undefined,
    });
    const service = new OrchestratorTaskService(runtime as never, { store });
    const taskId = await seedTwoLaneTask(store);

    await service.sendToTaskAgent(
      taskId,
      "word",
      "Fix the reported gaps and re-verify.",
      "validation_failed",
    );
    expect(sent).toHaveLength(1);
    const brief = sent[0]?.text ?? "";
    // The lane owns its slice, stated as the ONLY deliverable.
    expect(brief).toContain("--- Lane Scope ---");
    expect(brief).toContain(WORD_LANE_TASK);
    expect(brief).toMatch(/ONLY this lane's deliverable/);
    // Lane criteria only — the sibling's contract item must not be restated.
    const criteria = criteriaSection(brief);
    expect(criteria).toMatch(/word counter/i);
    expect(criteria).not.toMatch(/tip calculator/i);
    // The umbrella verbatim request is suppressed for a lane retry: rendered,
    // it instructed the lane to satisfy every sibling's deliverable in full.
    expect(brief).not.toContain(UMBRELLA_REQUEST);
    expect(brief).not.toContain("must satisfy it in full");

    // The sibling lane keeps its own slice-scoped brief, untouched by the
    // word-counter lane's retry.
    await service.sendToTaskAgent(
      taskId,
      "tip",
      "Fix the reported gaps and re-verify.",
      "validation_failed",
    );
    const tipBrief = sent[1]?.text ?? "";
    expect(tipBrief).toContain(TIP_LANE_TASK);
    const tipCriteria = criteriaSection(tipBrief);
    expect(tipCriteria).toMatch(/tip calculator/i);
    expect(tipCriteria).not.toMatch(/word counter/i);
  });

  it("single-lane retry briefs keep the umbrella criteria and the verbatim request (no lane section)", () => {
    const brief = buildGoalFollowUp({
      goal: "demo-hello page",
      message: "fix it",
      acceptanceCriteria: ["the page shows a gradient background"],
      reason: "validation_failed",
      originalRequest: "make a demo-hello page with a gradient",
    });
    expect(brief).not.toContain("--- Lane Scope ---");
    expect(brief).toContain("make a demo-hello page with a gradient");
  });
});

describe("lane-launch create (per-lane task records)", () => {
  it("generates criteria from the lane goal, never the umbrella originalRequest", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { prompts, useModel } = makeLaneModel();
    const service = new OrchestratorTaskService(
      makeRuntime({ useModel }) as never,
      { store },
    );
    const detail = await service.createTask({
      title: "Word Counter Page",
      goal: WORD_LANE_TASK,
      originalRequest: UMBRELLA_REQUEST,
      metadata: { requestVoicePart: "part:1" },
    });
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/tip calculator/i);
    }
    const doc = await store.getTask(detail?.id ?? "");
    const criteria = doc?.task.acceptanceCriteria ?? [];
    expect(criteria.length).toBeGreaterThan(0);
    expect(criteria.join("\n")).not.toMatch(/tip calculator/i);
    expect(criteria).toContain("the page shows a word counter");
  });
});

describe("pass relay speaks product, not criteria", () => {
  it("never posts verifier bookkeeping ('every acceptance criterion') to the room", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const posted: string[] = [];
    const runtime = makeRuntime({
      sendMessageToTarget: vi.fn(
        async (_target: unknown, content: { text: string }) => {
          posted.push(content.text);
        },
      ),
    });
    const service = new OrchestratorTaskService(runtime as never, { store });
    const detail = await store.createTask({
      title: UMBRELLA_GOAL,
      goal: UMBRELLA_GOAL,
      acceptanceCriteria: [...UMBRELLA_CRITERIA],
      roomId: "room-1",
      metadata: { acceptanceCriteriaOrigin: "generated", source: "discord" },
    });
    const taskId = detail.task.id;
    await addLane(store, taskId, "tip", "part:0", TIP_LANE_TASK);
    await addLane(store, taskId, "word", "part:1", WORD_LANE_TASK);
    // A retried session makes the recovery notice eligible (sawRetry).
    await store.updateSession("word", {
      metadata: { requestVoicePart: "part:1", retryCount: 1 },
    });

    await (
      service as unknown as {
        notifyVerifyRecovery(taskId: string): Promise<void>;
      }
    ).notifyVerifyRecovery(taskId);

    expect(posted).toHaveLength(1);
    const text = posted[0] ?? "";
    expect(text).not.toMatch(/acceptance criteri/i);
    expect(text).toMatch(/checks out|verified/);
  });
});
