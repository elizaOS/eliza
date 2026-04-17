/**
 * Unit tests for the EXECUTE_CODE action.
 *
 * Uses an in-memory fake runtime + an in-memory trajectory logger that
 * captures startTrajectory/endTrajectory/annotateStep calls so we can assert
 * the parent / child relationship written for a 3-step script.
 *
 * No SQL mocks (per repo rule: tests that touch persistence use pglite
 * directly). This test exercises the trajectory wiring at the service-
 * interface boundary which is real plugin behavior; the storage layer is
 * exercised separately by the @elizaos/agent test suite.
 */

import { describe, expect, it } from "vitest";

import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type Service,
  type UUID,
} from "@elizaos/core";

import { executeCodeAction } from "../src/action.js";

interface AnnotateCall {
  stepId: string;
  kind?: string;
  script?: string;
  childSteps?: string[];
  appendChildSteps?: string[];
  usedSkills?: string[];
}

interface StartTrajectoryCall {
  stepId: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

interface EndTrajectoryCall {
  stepId: string;
  status?: string;
}

class FakeTrajectoryService {
  static serviceType = "trajectories" as const;
  capabilityDescription = "fake";

  startCalls: StartTrajectoryCall[] = [];
  endCalls: EndTrajectoryCall[] = [];
  annotateCalls: AnnotateCall[] = [];

  isEnabled(): boolean {
    return true;
  }

  async startTrajectory(
    stepId: string,
    options?: {
      agentId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    this.startCalls.push({
      stepId,
      source: options?.source,
      metadata: options?.metadata,
    });
    return stepId;
  }

  async endTrajectory(stepId: string, status?: string): Promise<void> {
    this.endCalls.push({ stepId, status });
  }

  async annotateStep(params: AnnotateCall): Promise<void> {
    this.annotateCalls.push({ ...params });
  }
}

function createFakeRuntime({
  actions,
  trajectoryService,
}: {
  actions: Action[];
  trajectoryService: FakeTrajectoryService;
}): IAgentRuntime {
  const services = new Map<string, Service>();
  services.set("trajectories", trajectoryService as unknown as Service);

  const runtime: Partial<IAgentRuntime> = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    actions,
    getSetting: () => undefined,
    getService: (name: string): Service | null => {
      return services.get(name) ?? null;
    },
    getServicesByType: (name: string): Service[] => {
      const svc = services.get(name);
      return svc ? [svc] : [];
    },
  };

  return runtime as IAgentRuntime;
}

function createMessage(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000aaa" as UUID,
    entityId: "00000000-0000-0000-0000-000000000bbb" as UUID,
    roomId: "00000000-0000-0000-0000-000000000ccc" as UUID,
    content: { text: "" },
  } as Memory;
}

function makeRecordingAction(name: string, calls: string[]): Action {
  return {
    name,
    description: `${name} for tests`,
    similes: [],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options): Promise<ActionResult> => {
      const params = (options as { parameters?: { value?: unknown } } | undefined)
        ?.parameters;
      calls.push(`${name}:${JSON.stringify(params ?? null)}`);
      return {
        success: true,
        text: `${name} ok`,
        data: { actionName: name, params },
      } as ActionResult;
    },
  };
}

describe("EXECUTE_CODE action", () => {
  it("dispatches a 3-step script and links child steps to the parent", async () => {
    const dispatched: string[] = [];
    const actionA = makeRecordingAction("ACTION_A", dispatched);
    const actionB = makeRecordingAction("ACTION_B", dispatched);
    const actionC = makeRecordingAction("ACTION_C", dispatched);

    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [actionA, actionB, actionC],
      trajectoryService,
    });
    const message = createMessage();

    const script = `
      const r1 = await tools.ACTION_A({ value: 1 });
      const r2 = await tools.ACTION_B({ value: 2 });
      const r3 = await tools.ACTION_C({ value: 3 });
      return { steps: [r1.action, r2.action, r3.action] };
    `;

    const callbacks: { text?: string }[] = [];
    const result = await executeCodeAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { script } },
      async (response) => {
        callbacks.push(response);
        return [];
      },
    );

    if (!result || typeof result !== "object" || !("success" in result)) {
      throw new Error("expected ActionResult");
    }
    expect(result.success).toBe(true);

    // 3 actions dispatched in order
    expect(dispatched).toEqual([
      'ACTION_A:{"value":1}',
      'ACTION_B:{"value":2}',
      'ACTION_C:{"value":3}',
    ]);

    // One parent trajectory step opened + closed
    expect(trajectoryService.startCalls).toHaveLength(1);
    expect(trajectoryService.endCalls).toHaveLength(1);
    const parentStepId = trajectoryService.startCalls[0].stepId;
    expect(parentStepId).toMatch(/^execcode-/);
    expect(trajectoryService.endCalls[0].stepId).toBe(parentStepId);
    expect(trajectoryService.endCalls[0].status).toBe("completed");

    // annotateStep called twice on the parent: once at start (kind+script),
    // once at end (childSteps).
    const parentAnnotates = trajectoryService.annotateCalls.filter(
      (c) => c.stepId === parentStepId,
    );
    expect(parentAnnotates.length).toBeGreaterThanOrEqual(2);

    const initial = parentAnnotates.find((c) => c.kind === "executeCode");
    expect(initial).toBeDefined();
    expect(initial?.script).toBe(script);
    expect(initial?.childSteps).toEqual([]);

    const final = parentAnnotates[parentAnnotates.length - 1];
    expect(final.childSteps).toBeDefined();
    expect(final.childSteps).toHaveLength(3);
    for (const child of final.childSteps ?? []) {
      expect(child).toMatch(/^execcode-child-/);
    }
  });

  it("rejects non-JSON-cloneable args", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [makeRecordingAction("ACTION_A", dispatched)],
      trajectoryService,
    });
    const message = createMessage();

    const script = `
      // pass a class instance — must reject
      class Box { constructor(v){ this.v = v; } }
      await tools.ACTION_A(new Box(1));
    `;

    const result = await executeCodeAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { script } },
    );
    if (!result || typeof result !== "object" || !("success" in result)) {
      throw new Error("expected ActionResult");
    }
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/JSON-cloneable|plain object/);
    expect(dispatched).toEqual([]);
  });

  it("enforces the timeout via Promise.race", async () => {
    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [],
      trajectoryService,
    });
    const message = createMessage();

    const script = `await new Promise(r => setTimeout(r, 200));`;

    const result = await executeCodeAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { script, timeoutMs: 25 } },
    );
    if (!result || typeof result !== "object" || !("success" in result)) {
      throw new Error("expected ActionResult");
    }
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/timed out/);
    expect(trajectoryService.endCalls[0]?.status).toBe("error");
  });

  it("honors allowedActions allow-list", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [
        makeRecordingAction("ACTION_A", dispatched),
        makeRecordingAction("ACTION_B", dispatched),
      ],
      trajectoryService,
    });
    const message = createMessage();

    const script = `await tools.ACTION_B({});`;

    const result = await executeCodeAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { script, allowedActions: ["ACTION_A"] } },
    );
    if (!result || typeof result !== "object" || !("success" in result)) {
      throw new Error("expected ActionResult");
    }
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/not in allowedActions/);
    expect(dispatched).toEqual([]);
  });
});
