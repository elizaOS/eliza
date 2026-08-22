/**
 * PAGE_DELEGATE boundary tests for canonical child dispatch and the structured
 * non-retryable child-unavailable failure. The runtime stand-in uses a real
 * Action shape so alias repair and failure listing exercise the same context,
 * simile, discriminator, and parameter contracts as production without a model.
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
  it.each(["WORKFLOW_CREATE", "CREATE_WORKFLOW"])(
    "canonicalizes %s to WORKFLOW action=create using the user's request",
    async (alias) => {
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
    },
  );

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

function makeChildAction(
  overrides: Partial<Action> & { name: string },
): Action {
  return {
    description: `${overrides.name} test child action.`,
    contexts: ["tasks"],
    validate: async () => true,
    handler: async (): Promise<ActionResult> => ({
      success: true,
      text: "ok",
    }),
    ...overrides,
  } as Action;
}

async function invokeOnPage(
  runtime: IAgentRuntime,
  page: string,
  action: string,
): Promise<ActionResult> {
  const result = await pageDelegateAction.handler(
    runtime,
    makeMessage(),
    undefined,
    { parameters: { page, action } } as HandlerOptions,
  );
  if (!result) throw new Error("PAGE_DELEGATE returned no result");
  return result;
}

describe("PAGE_DELEGATE structured child-unavailable failure", () => {
  it("returns a non-retryable PAGE_CHILD_UNAVAILABLE failure listing the page's real actions", async () => {
    const runtime = {
      actions: [
        pageDelegateAction,
        makeChildAction({ name: "OWNER_REMINDERS", contexts: ["tasks"] }),
        makeChildAction({ name: "OWNER_ROUTINES", contexts: ["tasks"] }),
        // Not on the owner page's context set — must NOT be listed.
        makeChildAction({ name: "BROWSER", contexts: ["browser"] }),
      ],
    } as IAgentRuntime;

    const result = await invokeOnPage(runtime, "owner", "CREATE_HABIT");

    expect(result.success).toBe(false);
    expect(result.data).toEqual({
      actionName: "PAGE_DELEGATE",
      code: "PAGE_CHILD_UNAVAILABLE",
      page: "owner",
      requestedAction: "CREATE_HABIT",
      availableActions: ["OWNER_REMINDERS", "OWNER_ROUTINES"],
      retryable: false,
    });
    expect(result.text).toContain(
      "CREATE_HABIT is not available on the owner page.",
    );
    expect(result.text).toContain(
      "Actions available on the owner page: OWNER_REMINDERS, OWNER_ROUTINES.",
    );
    // The delegate parent never lists itself as a correction target.
    expect(result.text).not.toContain("PAGE_DELEGATE,");
  });

  it("says explicitly when the deployment registers no child actions for the page", async () => {
    const actions: Action[] = [pageDelegateAction];
    const runtime = { actions } as IAgentRuntime;

    const result = await invokeOnPage(runtime, "owner", "CREATE_HABIT");

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      code: "PAGE_CHILD_UNAVAILABLE",
      availableActions: [],
      retryable: false,
    });
    expect(result.text).toContain(
      "No child actions are registered for the owner page in this deployment.",
    );
  });

  it("lists every available action in sorted order", async () => {
    const children = Array.from({ length: 45 }, (_value, index) =>
      makeChildAction({
        name: `CHILD_${String(index).padStart(2, "0")}`,
        contexts: ["tasks"],
      }),
    );
    const runtime = {
      actions: [pageDelegateAction, ...children],
    } as IAgentRuntime;

    const result = await invokeOnPage(runtime, "owner", "NOT_A_REAL_ACTION");

    expect(result.success).toBe(false);
    const availableActions = (result.data as { availableActions: string[] })
      .availableActions;
    expect(availableActions).toHaveLength(45);
    expect(availableActions[0]).toBe("CHILD_00");
    expect(availableActions[44]).toBe("CHILD_44");
    expect([...availableActions].sort()).toEqual(availableActions);
  });

  it("returns a non-retryable PAGE_CHILD_VALIDATE_REJECTED failure when the child refuses", async () => {
    const runtime = {
      actions: [
        pageDelegateAction,
        makeChildAction({
          name: "OWNER_REMINDERS",
          contexts: ["tasks"],
          validate: async () => false,
        }),
      ],
    } as IAgentRuntime;

    const result = await invokeOnPage(runtime, "owner", "OWNER_REMINDERS");

    expect(result.success).toBe(false);
    expect(result.data).toEqual({
      actionName: "PAGE_DELEGATE",
      code: "PAGE_CHILD_VALIDATE_REJECTED",
      page: "owner",
      requestedAction: "OWNER_REMINDERS",
      retryable: false,
    });
  });
});

describe("PAGE_DELEGATE child parameter envelope", () => {
  it("accepts and forwards legacy nested browser parameters", async () => {
    const nestedParameterSchema = pageDelegateAction.parameters?.find(
      (parameter) => parameter.name === "parameters",
    )?.schema;
    expect(nestedParameterSchema).toMatchObject({
      type: "object",
      additionalProperties: true,
    });

    let receivedOptions: HandlerOptions | undefined;
    const browserAction = makeChildAction({
      name: "BROWSER_OPEN",
      contexts: ["browser"],
      handler: async (
        _runtime,
        _message,
        _state,
        options,
      ): Promise<ActionResult> => {
        receivedOptions = options;
        return { success: true, text: "Opened apple.com." };
      },
    });
    const runtime = {
      actions: [pageDelegateAction, browserAction],
    } as IAgentRuntime;

    const result = await pageDelegateAction.handler(
      runtime,
      makeMessage(),
      undefined,
      {
        parameters: {
          page: "browser",
          action: "BROWSER_OPEN",
          parameters: { url: "https://www.apple.com" },
        },
      } as HandlerOptions,
    );

    expect(result?.success).toBe(true);
    expect(receivedOptions?.parameters).toEqual({
      url: "https://www.apple.com",
    });
  });
});
