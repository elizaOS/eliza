/**
 * PAGE_DELEGATE boundary tests for canonical child dispatch. The runtime stand-in
 * uses a real Action shape so alias repair exercises the same context, simile,
 * discriminator, and parameter contracts as production without a model.
 */
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { pageDelegateAction } from "./page-action-groups.ts";

const CREATE_REQUEST =
  "Create a workflow named Computer Smithers Proof with a Manual Trigger, then a Set node, and keep it inactive.";

function makeMessage(): Memory {
  return {
    content: { text: CREATE_REQUEST, source: "client_chat" },
  } as Memory;
}

function makeRuntime(handler: Action["handler"]): IAgentRuntime {
  const workflowAction: Action = {
    name: "WORKFLOW",
    description: "Manage workflows through a canonical action discriminator.",
    contexts: ["general", "automation"],
    contextGate: { anyOf: ["general", "automation"] },
    similes: ["CREATE_WORKFLOW"],
    parameters: [
      {
        name: "action",
        description: "Workflow operation.",
        required: true,
        schema: { type: "string", enum: ["list", "create", "run"] },
      },
      {
        name: "seedPrompt",
        description: "Natural-language create request.",
        schema: { type: "string" },
      },
      {
        name: "active",
        description: "Whether to activate the new workflow.",
        schema: { type: "boolean" },
      },
    ],
    validate: async () => true,
    handler,
  };
  return { actions: [pageDelegateAction, workflowAction] } as IAgentRuntime;
}

async function invoke(
  runtime: IAgentRuntime,
  action: string,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await pageDelegateAction.handler(
    runtime,
    makeMessage(),
    undefined,
    {
      parameters: { page: "automation", action, parameters },
    } as HandlerOptions,
  );
  if (!result) throw new Error("PAGE_DELEGATE returned no result");
  return result;
}

describe("PAGE_DELEGATE workflow alias repair", () => {
  it.each([
    "WORKFLOW_CREATE",
    "CREATE_WORKFLOW",
  ])("canonicalizes %s to WORKFLOW action=create using the user's request", async (alias) => {
    let calls = 0;
    let receivedOptions: HandlerOptions | undefined;
    const handler: Action["handler"] = async (
      _runtime,
      _message,
      _state,
      options,
    ): Promise<ActionResult> => {
      calls += 1;
      receivedOptions = options;
      return {
        success: true,
        text: "created",
      };
    };
    const runtime = makeRuntime(handler);

    const result = await invoke(runtime, alias, {
      definition: {
        nodes: [{ type: "invented", parameters: { value: "wrong" } }],
      },
      active: false,
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(1);
    expect(receivedOptions?.parameters).toEqual({
      action: "create",
      seedPrompt: CREATE_REQUEST,
      active: false,
    });
    expect(receivedOptions?.parameters).not.toHaveProperty("definition");
  });

  it("preserves an already-canonical WORKFLOW delegation", async () => {
    let receivedOptions: HandlerOptions | undefined;
    const handler: Action["handler"] = async (
      _runtime,
      _message,
      _state,
      options,
    ): Promise<ActionResult> => {
      receivedOptions = options;
      return {
        success: true,
        text: "created",
      };
    };
    const runtime = makeRuntime(handler);

    await invoke(runtime, "WORKFLOW", {
      action: "create",
      seedPrompt: "Explicit canonical prompt",
    });

    expect(receivedOptions?.parameters).toEqual({
      action: "create",
      seedPrompt: "Explicit canonical prompt",
    });
  });

  it("tells the planner to use WORKFLOW directly", () => {
    expect(pageDelegateAction.routingHint).toContain(
      "Workflow lifecycle requests must call WORKFLOW directly",
    );
    expect(pageDelegateAction.routingHint).toContain(
      "never wrap them in PAGE_DELEGATE",
    );
  });
});
