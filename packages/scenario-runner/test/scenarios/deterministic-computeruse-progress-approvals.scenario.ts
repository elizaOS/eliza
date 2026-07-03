import type { Plugin } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { useComputerAction } from "../../../../plugins/plugin-computeruse/src/actions/use-computer.ts";
import type { ComputerUseService } from "../../../../plugins/plugin-computeruse/src/services/computer-use-service.ts";
import type {
  ApprovalResolution,
  ApprovalSnapshot,
  PendingApproval,
} from "../../../../plugins/plugin-computeruse/src/types.ts";

const approvalId = "approval_123_abc";

function pendingApproval(): PendingApproval {
  return {
    id: approvalId,
    command: "computer_use_click",
    parameters: { action: "click" },
    requestedAt: "2026-06-22T14:00:00.000Z",
  };
}

function makeApprovalSnapshot(
  pendingApprovals: PendingApproval[],
): ApprovalSnapshot {
  return {
    mode: "approve_all",
    pendingCount: pendingApprovals.length,
    pendingApprovals,
  };
}

function createFakeComputerUseService(): Partial<ComputerUseService> {
  let pending = false;
  const listeners = new Set<(snapshot: ApprovalSnapshot) => void>();

  function emit() {
    const snapshot = makeApprovalSnapshot(pending ? [pendingApproval()] : []);
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  return {
    getApprovalSnapshot: () =>
      makeApprovalSnapshot(pending ? [pendingApproval()] : []),
    subscribeApprovals: (listener: (snapshot: ApprovalSnapshot) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    executeDesktopAction: async () => {
      pending = true;
      emit();
      return {
        success: true,
        message: "Scenario click completed after approval relay.",
      };
    },
    resolveApproval: (
      id: string,
      approved: boolean,
      reason?: string,
    ): ApprovalResolution | null => {
      if (!pending || id !== approvalId) {
        return null;
      }
      pending = false;
      emit();
      return {
        id,
        command: "computer_use_click",
        approved,
        cancelled: false,
        mode: "approve_all",
        requestedAt: "2026-06-22T14:00:00.000Z",
        resolvedAt: "2026-06-22T14:00:01.000Z",
        ...(reason ? { reason } : {}),
      };
    },
  };
}

async function seedComputerUse(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as
    | ({
        getService?: (name: string) => unknown;
        registerPlugin?: (plugin: Plugin) => Promise<void>;
      } & Record<string, unknown>)
    | undefined;
  if (!runtime?.registerPlugin) {
    return "runtime.registerPlugin unavailable";
  }

  const fakeService = createFakeComputerUseService();
  const previousGetService = runtime.getService?.bind(runtime);
  runtime.getService = (name: string) => {
    if (name === "computeruse") {
      return fakeService;
    }
    return previousGetService?.(name) ?? null;
  };

  await runtime.registerPlugin({
    name: "scenario-computeruse",
    description: "Deterministic computer-use approval relay scenario plugin",
    actions: [useComputerAction],
  });
}

function expectApprovalPrompt(
  execution: ScenarioTurnExecution,
): string | undefined {
  if (!execution.responseText.includes("[CHOICE:computeruse-approval")) {
    return `missing approval choice block in response: ${JSON.stringify(execution.responseText)}`;
  }
  if (!execution.responseText.includes(`cua:${approvalId}:approve=Approve`)) {
    return "approval prompt did not include the approve button value";
  }
  if (!execution.responseText.includes(`cua:${approvalId}:deny=Deny`)) {
    return "approval prompt did not include the deny button value";
  }
  if (
    !execution.responseText.includes(
      "Scenario click completed after approval relay.",
    )
  ) {
    return "approval action did not complete after emitting the prompt";
  }
  return undefined;
}

function expectApprovalResolved(
  execution: ScenarioTurnExecution,
): string | undefined {
  if (
    execution.responseText !== `Computer-use approval ${approvalId} approved.`
  ) {
    return `unexpected approval resolution response: ${JSON.stringify(execution.responseText)}`;
  }
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "COMPUTER_USE",
  );
  if (action?.result?.success !== true) {
    return `expected COMPUTER_USE resolution success, saw ${JSON.stringify(action?.result)}`;
  }
  return undefined;
}

function expectApprovalFlow(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter(
    (candidate) => candidate.actionName === "COMPUTER_USE",
  );
  if (calls.length !== 2) {
    return `expected two COMPUTER_USE calls, saw ${calls.length}`;
  }
  const blob = JSON.stringify(
    calls.map((action) => ({
      success: action.result?.success,
      text: action.result?.text,
      data: action.result?.data,
    })),
  );
  for (const expected of [
    "Scenario click completed after approval relay.",
    `Computer-use approval ${approvalId} approved.`,
  ]) {
    if (!blob.includes(expected)) {
      return `expected approval flow to include ${JSON.stringify(expected)}, saw ${blob}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "deterministic-computeruse-progress-approvals",
  lane: "pr-deterministic",
  title: "Computer-use approval relay buttons",
  domain: "computeruse",
  tags: ["pr", "deterministic", "zero-cost", "computeruse", "approvals"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register COMPUTER_USE with a deterministic approval service",
      apply: seedComputerUse,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "COMPUTER_USE emits approval buttons",
      actionName: "COMPUTER_USE",
      text: "Click with approval relay",
      options: {
        parameters: { action: "click" },
      },
      assertTurn: expectApprovalPrompt,
    },
    {
      kind: "action",
      name: "COMPUTER_USE resolves approve callback",
      actionName: "COMPUTER_USE",
      text: `cua:${approvalId}:approve`,
      assertTurn: expectApprovalResolved,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "computeruse-approval-flow-results",
      predicate: expectApprovalFlow,
    },
  ],
});
