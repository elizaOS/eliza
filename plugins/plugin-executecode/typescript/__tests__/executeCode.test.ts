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

function makeRecordingAction(
  name: string,
  calls: string[],
  contexts?: string[],
): Action {
  const action: Action = {
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
  if (contexts) {
    (action as Action & { contexts?: string[] }).contexts = contexts;
  }
  return action;
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

  it("defaults to context-filtered actions when state supplies routing context", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const walletAction = makeRecordingAction("WALLET_ACTION", dispatched, [
      "wallet",
    ]);
    const mediaAction = makeRecordingAction("MEDIA_ACTION", dispatched, [
      "media",
    ]);
    const runtime = createFakeRuntime({
      actions: [walletAction, mediaAction],
      trajectoryService,
    });
    const message = createMessage();
    const state = {
      values: {
        __contextRouting: {
          primaryContext: "wallet",
          secondaryContexts: [],
        },
      },
      data: {},
    } as unknown as Parameters<typeof executeCodeAction.handler>[2];

    // Calling MEDIA_ACTION is blocked because wallet context doesn't include
    // media. WALLET_ACTION is allowed.
    const blockedResult = await executeCodeAction.handler(
      runtime,
      message,
      state,
      { parameters: { script: `await tools.MEDIA_ACTION({});` } },
    );
    if (!blockedResult || typeof blockedResult !== "object" || !("success" in blockedResult)) {
      throw new Error("expected ActionResult");
    }
    expect(blockedResult.success).toBe(false);
    expect(blockedResult.text).toMatch(
      /not in current routing contexts \(wallet,general\)/,
    );

    const allowedResult = await executeCodeAction.handler(
      runtime,
      message,
      state,
      { parameters: { script: `await tools.WALLET_ACTION({});` } },
    );
    if (!allowedResult || typeof allowedResult !== "object" || !("success" in allowedResult)) {
      throw new Error("expected ActionResult");
    }
    expect(allowedResult.success).toBe(true);
    expect(dispatched).toEqual(["WALLET_ACTION:{}"]);
  });

  it("falls through to all actions when no state is supplied", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [
        makeRecordingAction("ACTION_A", dispatched, ["wallet"]),
        makeRecordingAction("ACTION_B", dispatched, ["media"]),
      ],
      trajectoryService,
    });
    const message = createMessage();

    const result = await executeCodeAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { script: `await tools.ACTION_B({});` } },
    );
    if (!result || typeof result !== "object" || !("success" in result)) {
      throw new Error("expected ActionResult");
    }
    expect(result.success).toBe(true);
    expect(dispatched).toEqual(["ACTION_B:{}"]);
  });

  it("context.getMemories ignores roomId override and scopes to the message room", async () => {
    // The script must not be able to reach cross-room memories by passing a
    // different roomId. Confirmed via the rpc-bridge implementation which
    // passes the fixed message.roomId through to runtime.getMemories.
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const messageRoom = "00000000-0000-0000-0000-000000000ccc" as UUID;
    const runtime = {
      ...createFakeRuntime({ actions: [], trajectoryService }),
    } as IAgentRuntime;

    const capturedRoomIds: string[] = [];
    (runtime as unknown as { getMemories: IAgentRuntime["getMemories"] }).getMemories =
      (async (params: { tableName: string; roomId: string; limit?: number }) => {
        capturedRoomIds.push(params.roomId);
        return [];
      }) as unknown as IAgentRuntime["getMemories"];

    const message = createMessage();
    const script = `
      await context.getMemories({
        tableName: "messages",
        limit: 3,
        roomId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      });
      return "ok";
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
    expect(result.success).toBe(true);
    // Runtime saw the message's own roomId, not the fake override.
    expect(capturedRoomIds).toEqual([messageRoom]);
  });

  it("cannot reach runtime.databaseAdapter or runtime.services via context", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [makeRecordingAction("ACTION_A", dispatched)],
      trajectoryService,
    });
    const message = createMessage();

    // The script probes `context` for escape hatches and returns what it found.
    const script = `
      const keys = Object.keys(context).sort();
      return {
        keys,
        hasDatabaseAdapter: "databaseAdapter" in context,
        hasServices: "services" in context,
        hasRuntime: "runtime" in context,
      };
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
    expect(result.success).toBe(true);
    const data = (result as ActionResult & {
      data?: { returnValue?: { keys: string[]; hasDatabaseAdapter: boolean; hasServices: boolean; hasRuntime: boolean } };
    }).data;
    const returnValue = data?.returnValue;
    expect(returnValue?.hasDatabaseAdapter).toBe(false);
    expect(returnValue?.hasServices).toBe(false);
    expect(returnValue?.hasRuntime).toBe(false);
    // Positive: only the documented context surface is present.
    expect(returnValue?.keys).toEqual([
      "agentId",
      "entityId",
      "getMemories",
      "roomId",
      "searchMemories",
    ]);
  });

  it("sanitizes class-instance data returned from an action to undefined", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();

    class HostBound {
      constructor(public secret: string) {}
    }

    const leakyAction: Action = {
      name: "LEAKY_ACTION",
      description: "returns a class instance in data",
      similes: [],
      validate: async () => true,
      handler: async (): Promise<ActionResult> => {
        dispatched.push("LEAKY_ACTION");
        return {
          success: true,
          text: "ok",
          data: {
            hostBound: new HostBound("secret-value"),
            safeString: "visible",
          } as ActionResult["data"],
        };
      },
    };
    const runtime = createFakeRuntime({
      actions: [leakyAction],
      trajectoryService,
    });
    const message = createMessage();

    const script = `
      const r = await tools.LEAKY_ACTION({});
      return {
        hasHostBound: r.data && "hostBound" in r.data,
        safeString: r.data?.data?.safeString,
      };
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
    expect(result.success).toBe(true);
    const returnValue = (result as ActionResult & {
      data?: { returnValue?: { hasHostBound: boolean; safeString: string } };
    }).data?.returnValue;
    // sanitizeForScript drops non-plain-object fields — `hostBound` becomes
    // undefined and omitted from the sanitized data object.
    expect(returnValue?.hasHostBound).toBe(false);
    expect(returnValue?.safeString).toBe("visible");
  });

  it("allowedActions explicit list bypasses context filter", async () => {
    const dispatched: string[] = [];
    const trajectoryService = new FakeTrajectoryService();
    const runtime = createFakeRuntime({
      actions: [
        makeRecordingAction("ACTION_A", dispatched, ["wallet"]),
        makeRecordingAction("ACTION_B", dispatched, ["media"]),
      ],
      trajectoryService,
    });
    const message = createMessage();
    const state = {
      values: {
        __contextRouting: { primaryContext: "wallet", secondaryContexts: [] },
      },
      data: {},
    } as unknown as Parameters<typeof executeCodeAction.handler>[2];

    // Wallet routing would normally block ACTION_B, but explicit allowedActions
    // wins.
    const result = await executeCodeAction.handler(
      runtime,
      message,
      state,
      {
        parameters: {
          script: `await tools.ACTION_B({});`,
          allowedActions: ["ACTION_B"],
        },
      },
    );
    if (!result || typeof result !== "object" || !("success" in result)) {
      throw new Error("expected ActionResult");
    }
    expect(result.success).toBe(true);
    expect(dispatched).toEqual(["ACTION_B:{}"]);
  });
});
