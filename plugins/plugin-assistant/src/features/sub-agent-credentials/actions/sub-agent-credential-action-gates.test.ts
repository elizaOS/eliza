import type { Memory } from "@elizaos/core"
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime"
import { describe, expect, test, vi } from "vitest"
import {
  SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
  SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
} from "../types.ts"
import { awaitChildAgentDecisionAction } from "./await-child-agent-decision.ts"
import { declareSubAgentCredentialScopeAction } from "./declare-sub-agent-credential-scope.ts"
import { retrieveChildAgentResultsAction } from "./retrieve-child-agent-results.ts"
import { tunnelCredentialToChildSessionAction } from "./tunnel-credential-to-child-session.ts"
import { collectV5PlannerCandidateActions } from "../../../services/message/action-surface.ts"

function createCredentialRuntime() {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Credential gate test", bio: "test" },
    logLevel: "fatal",
  })
  const services: Record<string, unknown> = {
    [SUB_AGENT_CHILD_DECISION_BUS_SERVICE]: {
      awaitDecision: vi.fn(),
    },
    [SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE]: {
      getResults: vi.fn(),
    },
    [SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE]: {
      declareScope: vi.fn(),
      tunnelCredential: vi.fn(),
    },
  }
  vi.spyOn(runtime, "getService").mockImplementation((name) =>
    (services[name] ?? null) as never,
  )
  runtime.actions.length = 0
  runtime.actions.push(
    awaitChildAgentDecisionAction,
    declareSubAgentCredentialScopeAction,
    retrieveChildAgentResultsAction,
    tunnelCredentialToChildSessionAction,
  )
  return runtime
}

const credentialActionNames = [
  "AWAIT_CHILD_AGENT_DECISION",
  "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
  "RETRIEVE_CHILD_AGENT_RESULTS",
  "TUNNEL_CREDENTIAL_TO_CHILD_SESSION",
]

function message() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    roomId: "00000000-0000-4000-8000-000000000002",
    entityId: "00000000-0000-4000-8000-000000000003",
    content: { text: "request a child agent credential" },
  } as Memory
}

describe("sub-agent credential planner admission", () => {
  test("does not expose credential actions to a general non-owner caller", async () => {
    const runtime = createCredentialRuntime()
    const selected = await collectV5PlannerCandidateActions({
      runtime,
      message: message(),
      state: { values: {}, data: {}, text: "" },
      selectedContexts: ["general"],
      userRoles: ["USER"],
    })
    expect(selected.map((action) => action.name)).not.toEqual(
      expect.arrayContaining(credentialActionNames),
    )
    expect(selected).toHaveLength(0)
  })

  test("keeps the complete credential flow for an owner internal turn", async () => {
    const runtime = createCredentialRuntime()
    const selected = await collectV5PlannerCandidateActions({
      runtime,
      message: message(),
      state: { values: {}, data: {}, text: "" },
      selectedContexts: ["agent_internal"],
      userRoles: ["OWNER"],
    })
    expect(selected.map((action) => action.name)).toEqual(
      expect.arrayContaining(credentialActionNames),
    )
  })
})
