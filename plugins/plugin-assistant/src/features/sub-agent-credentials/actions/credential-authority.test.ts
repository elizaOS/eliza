/** Real planner admission/execution with deterministic child-service ports. */
import {
  buildPlannerToolsFromActions,
  canActionRun,
  executePlannedToolCall,
  type Memory,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { subAgentCredentialsPlugin } from "../plugin.ts";
import {
  SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
  SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
} from "../types.ts";

it("admits the owner coding flow and refuses non-owner calls before child services", async () => {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Credential authority", bio: [] },
    logLevel: "fatal",
  });
  await runtime.initialize();
  const declareScope = vi.fn(async () => ({
    credentialScopeId: "scope-1",
    scopedToken: "test-token",
    expiresAt: Date.now() + 60000,
    sensitiveRequestIds: [],
  }));
  const tunnelCredential = vi.fn(async () => {});
  const awaitDecision = vi.fn(async () => ({
    childSessionId: "child-1",
    decidedAt: Date.now(),
    decision: "done",
  }));
  const getResults = vi.fn(async () => ({
    childSessionId: "child-1",
    retrievedAt: Date.now(),
    transcript: "finished",
  }));
  const ports = new Map<string, unknown>([
    [SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE, { declareScope, tunnelCredential }],
    [SUB_AGENT_CHILD_DECISION_BUS_SERVICE, { awaitDecision }],
    [SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE, { getResults }],
  ]);
  const originalGetService = runtime.getService.bind(runtime);
  vi.spyOn(runtime, "getService").mockImplementation(
    (name) => (ports.get(name) ?? originalGetService(name)) as never,
  );
  const message = {
    id: crypto.randomUUID(),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text: "Complete the coding task", source: "test" },
  } as Memory;
  const actions = subAgentCredentialsPlugin.actions ?? [];
  const parameters: Record<string, Record<string, unknown>> = {
    DECLARE_SUB_AGENT_CREDENTIAL_SCOPE: {
      childSessionId: "child-1",
      credentialKeys: ["TEST_KEY"],
    },
    TUNNEL_CREDENTIAL_TO_CHILD_SESSION: {
      childSessionId: "child-1",
      credentialScopeId: "scope-1",
      key: "TEST_KEY",
      value: "test-value",
    },
    AWAIT_CHILD_AGENT_DECISION: { childSessionId: "child-1" },
    RETRIEVE_CHILD_AGENT_RESULTS: { childSessionId: "child-1" },
  };
  try {
    for (const action of actions) runtime.registerAction(action);
    for (const role of ["GUEST", "USER", "ADMIN"] as const) {
      for (const action of actions) {
        const context = {
          message,
          userRoles: [role],
          activeContexts: ["code"] as const,
        };
        expect(canActionRun(action, context)).toBe(false);
        const result = await executePlannedToolCall(runtime, context, {
          name: action.name,
          params: parameters[action.name],
        });
        expect(result.success).toBe(false);
      }
    }
    for (const port of [
      declareScope,
      tunnelCredential,
      awaitDecision,
      getResults,
    ])
      expect(port).not.toHaveBeenCalled();
    for (const action of actions) {
      const context = {
        message,
        userRoles: ["OWNER"] as const,
        activeContexts: ["code"] as const,
      };
      expect(canActionRun(action, context)).toBe(true);
      expect(await action.validate(runtime, message)).toBe(true);
      expect(buildPlannerToolsFromActions([action])[0].name).toBe(action.name);
      const result = await executePlannedToolCall(runtime, context, {
        name: action.name,
        params: parameters[action.name],
      });
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(
        canActionRun(action, {
          ...context,
          activeContexts: ["agent_internal"],
        }),
      ).toBe(true);
    }
    for (const port of [
      declareScope,
      tunnelCredential,
      awaitDecision,
      getResults,
    ])
      expect(port).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await runtime.stop();
    await runtime.close();
  }
});
