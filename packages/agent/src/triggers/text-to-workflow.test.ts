import { describe, expect, it, vi } from "vitest";
import {
  deployTextTriggerWorkflow,
  getWorkflowService,
  type WorkflowServiceRuntime,
} from "./text-to-workflow.js";

interface DeployCall {
  workflow: {
    name: string;
    nodes: Array<{
      type: string;
      parameters: Record<string, unknown>;
    }>;
    connections: Record<string, unknown>;
    active?: boolean;
  };
  userId: string;
}

function makeRuntimeWithService(
  deploy: (
    workflow: DeployCall["workflow"],
    userId: string,
  ) => Promise<{ id?: string; name?: string }>,
): { runtime: WorkflowServiceRuntime; calls: DeployCall[] } {
  const calls: DeployCall[] = [];
  const service = {
    deployWorkflow: async (
      workflow: DeployCall["workflow"],
      userId: string,
    ) => {
      calls.push({ workflow, userId });
      return deploy(workflow, userId);
    },
  };
  const runtime = {
    getService: (type: string): unknown =>
      type === "workflow" ? service : null,
  };
  return { runtime, calls };
}

describe("getWorkflowService", () => {
  it("returns null when the workflow service is not registered", () => {
    const runtime = {
      getService: () => null,
    };
    expect(getWorkflowService(runtime)).toBeNull();
  });

  it("rejects services without a deployWorkflow method", () => {
    const runtime = {
      getService: () => ({ somethingElse: () => null }),
    };
    expect(getWorkflowService(runtime)).toBeNull();
  });
});

describe("deployTextTriggerWorkflow", () => {
  it("returns null when the workflow service is missing", async () => {
    const runtime = {
      getService: () => null,
    };
    const result = await deployTextTriggerWorkflow(
      runtime,
      {
        displayName: "Daily PR sweep",
        instructions: "Review open PRs and summarize.",
        wakeMode: "inject_now",
      },
      "creator-1",
    );
    expect(result).toBeNull();
  });

  it("materializes a single-node respondToEvent workflow with the trigger fields", async () => {
    const { runtime, calls } = makeRuntimeWithService(async () => ({
      id: "wf-123",
      name: "Daily PR sweep (auto)",
    }));

    const result = await deployTextTriggerWorkflow(
      runtime,
      {
        displayName: "Daily PR sweep",
        instructions: "Review open PRs and summarize.",
        wakeMode: "next_autonomy_cycle",
      },
      "creator-1",
    );

    expect(result).toEqual({ id: "wf-123", name: "Daily PR sweep (auto)" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.userId).toBe("creator-1");
    expect(call.workflow.name).toBe("Daily PR sweep (auto)");
    expect(call.workflow.nodes).toHaveLength(1);
    expect(call.workflow.nodes[0].type).toBe(
      "workflows-nodes-base.respondToEvent",
    );
    expect(call.workflow.nodes[0].parameters).toEqual({
      instructions: "Review open PRs and summarize.",
      displayName: "Daily PR sweep",
      wakeMode: "next_autonomy_cycle",
    });
    expect(call.workflow.connections).toEqual({});
  });

  it("returns null when the workflow service did not return an id", async () => {
    const { runtime } = makeRuntimeWithService(async () => ({
      id: "",
      name: "",
    }));
    const result = await deployTextTriggerWorkflow(
      runtime,
      {
        displayName: "no creds workflow",
        instructions: "Do the thing.",
        wakeMode: "inject_now",
      },
      "creator-1",
    );
    expect(result).toBeNull();
  });

  it("falls back to the synthesized workflow name when the service returns no name", async () => {
    const deploy = vi.fn(async () => ({ id: "wf-1" }));
    const runtime = {
      getService: (type: string): unknown =>
        type === "workflow" ? { deployWorkflow: deploy } : null,
    };
    const result = await deployTextTriggerWorkflow(
      runtime,
      {
        displayName: "Greet",
        instructions: "Say hi.",
        wakeMode: "inject_now",
      },
      "creator-1",
    );
    expect(result).toEqual({ id: "wf-1", name: "Greet (auto)" });
    expect(deploy).toHaveBeenCalledTimes(1);
  });
});
