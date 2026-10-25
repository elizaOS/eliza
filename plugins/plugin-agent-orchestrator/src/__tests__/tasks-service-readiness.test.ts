/**
 * Verifies that the TASKS action survives the runtime's asynchronous service-start boundary.
 */

import type { IAgentRuntime, Memory, Service } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const ACP_SERVICE_TYPE = "ACP_SUBPROCESS_SERVICE";
const LIST_AGENTS_MESSAGE = {
  content: {
    text: "List the active coding agents.",
    action: "list_agents",
  },
} as unknown as Memory;

function runtimeWithAcp(): IAgentRuntime {
  return {
    getService: (type: string) =>
      type === "ACP_SERVICE" ? ({} as Service) : null,
    hasService: () => true,
  } as unknown as IAgentRuntime;
}

function chat(text: string): Memory {
  return { content: { text } } as unknown as Memory;
}

describe("TASKS validate reads the planner arguments", () => {
  it.each([
    [
      "Create a task to fix the login bug in acme/api",
      { action: "create", task: "Fix the login bug", repo: "acme/api" },
    ],
    [
      "Create a task to fix the login bug in the checkout",
      {
        action: "create",
        task: "Fix the login bug",
        workdir: "/workspaces/acme-api",
      },
    ],
    [
      "Add a note for the coding agent: also run the linter",
      { action: "send", input: "also run the linter" },
    ],
    [
      "Add a note to issue 12 on acme/api saying we shipped it",
      {
        action: "manage_issues",
        issueAction: "comment",
        repo: "acme/api",
        issueNumber: 12,
        body: "We shipped it.",
      },
    ],
  ])("is available for %s", async (text, parameters) => {
    await expect(
      tasksAction.validate(runtimeWithAcp(), chat(text), undefined, {
        parameters,
      }),
    ).resolves.toBe(true);
  });

  it.each([
    [{ action: "create", task: "Buy milk" }],
    [{ action: "create", task: "Buy milk", agentType: "claude" }],
  ])("keeps a plain to-do unavailable for %o", async (parameters) => {
    await expect(
      tasksAction.validate(
        runtimeWithAcp(),
        chat("Add a task to buy milk"),
        undefined,
        { parameters },
      ),
    ).resolves.toBe(false);
  });

  it("serves history from the task service when ACP is not running", async () => {
    const runtime = {
      getService: (type: string) =>
        type === "ORCHESTRATOR_TASK_SERVICE" ? { listTasks: () => [] } : null,
      hasService: () => false,
    } as unknown as IAgentRuntime;
    const message = chat("show my task history");

    await expect(
      tasksAction.validate(runtime, message, undefined, {
        parameters: { action: "history" },
      }),
    ).resolves.toBe(true);
    await expect(
      tasksAction.validate(runtime, message, undefined, {
        parameters: { action: "list_agents" },
      }),
    ).resolves.toBe(false);
  });
});

describe("TASKS service readiness", () => {
  it("waits for the registered ACP service before validating", async () => {
    const acpService = {} as Service;
    let loadCalls = 0;
    const runtime = {
      getService: () => null,
      hasService: (type: string) => type === ACP_SERVICE_TYPE,
      getServiceLoadPromise: async (type: string) => {
        expect(type).toBe(ACP_SERVICE_TYPE);
        loadCalls += 1;
        return acpService;
      },
    } as unknown as IAgentRuntime;

    await expect(
      tasksAction.validate(runtime, LIST_AGENTS_MESSAGE),
    ).resolves.toBe(true);
    expect(loadCalls).toBe(1);
  });

  it("does not expose TASKS when ACP startup fails", async () => {
    const runtime = {
      getService: () => null,
      hasService: (type: string) => type === ACP_SERVICE_TYPE,
      getServiceLoadPromise: async () => {
        throw new Error("startup failed");
      },
    } as unknown as IAgentRuntime;

    await expect(
      tasksAction.validate(runtime, LIST_AGENTS_MESSAGE),
    ).resolves.toBe(false);
  });

  it("does not attempt startup when the ACP service is not registered", async () => {
    let loadCalls = 0;
    const runtime = {
      getService: () => null,
      hasService: () => false,
      getServiceLoadPromise: async () => {
        loadCalls += 1;
        throw new Error("must not load");
      },
    } as unknown as IAgentRuntime;

    await expect(
      tasksAction.validate(runtime, LIST_AGENTS_MESSAGE),
    ).resolves.toBe(false);
    expect(loadCalls).toBe(0);
  });
});
