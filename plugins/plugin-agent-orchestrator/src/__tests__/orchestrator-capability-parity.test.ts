/**
 * Agent-control parity for the coding-agent views: every capability that
 * stops or writes to a session is human authority in the manifest and refused
 * by the bundle's interact(), and the terminal pane renders its stop, interrupt
 * and input controls as human-authority controls rather than agent elements.
 */

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uiMock = vi.hoisted(() => ({
  agentElementIds: [] as string[],
  client: {
    stopCodingAgent: vi.fn(),
    getCodingAgentTaskThread: vi.fn(),
    listCodingAgentTaskThreads: vi.fn(),
  },
}));

vi.mock("@elizaos/ui", () => {
  const omit = (props: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(
      Object.entries(props).filter(([key]) => !keys.includes(key)),
    );
  const styling = ["variant", "size", "radius", "shadow", "density", "asChild"];
  return {
    client: uiMock.client,
    Card: ({ children }: { children?: ReactNode }) => children,
    Button: (props: Record<string, unknown>) =>
      createElement("button", { type: "button", ...omit(props, styling) }),
    Input: (props: Record<string, unknown>) =>
      createElement("input", omit(props, styling)),
    useAgentElement: (options: { id: string }) => {
      uiMock.agentElementIds.push(options.id);
      return { ref: () => {}, agentProps: { "data-agent-id": options.id } };
    },
  };
});

const { default: taskCoordinatorPlugin } = await import("../ui/plugin.js");
const { interact } = await import("../ui/CodingAgentTasksPanel.interact.js");
const {
  HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS,
  HUMAN_ONLY_TASK_COORDINATOR_CAPABILITY_IDS,
  HUMAN_ONLY_TERMINAL_CONTROL_IDS,
} = await import("../ui/orchestrator-capability-authority.js");
const { ORCHESTRATOR_CAPABILITY_IDS } = await import(
  "../ui/orchestrator-capabilities.js"
);
const { PtyConsoleBase } = await import("../ui/PtyConsoleBase.js");

const views = taskCoordinatorPlugin.views ?? [];

function viewCapabilities(id: string) {
  const view = views.find((candidate) => candidate.id === id);
  expect(view).toBeDefined();
  return view?.capabilities ?? [];
}

describe("orchestrator capability authority", () => {
  beforeEach(() => {
    uiMock.agentElementIds.length = 0;
    vi.clearAllMocks();
  });

  it("marks exactly the human-only ids as human authority", () => {
    const humanOnly = new Set([
      ...HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS,
      ...HUMAN_ONLY_TASK_COORDINATOR_CAPABILITY_IDS,
    ]);
    for (const viewId of ["orchestrator", "cockpit", "task-coordinator"]) {
      for (const capability of viewCapabilities(viewId)) {
        expect(
          capability.authority === "human",
          `${viewId}/${capability.id}`,
        ).toBe(humanOnly.has(capability.id));
      }
    }
    const declared = new Set(
      viewCapabilities("orchestrator").map((capability) => capability.id),
    );
    expect(declared).toEqual(new Set(ORCHESTRATOR_CAPABILITY_IDS));
  });

  it("refuses stop-session without stopping anything", async () => {
    await expect(
      interact("stop-session", { sessionId: "session-1" }),
    ).rejects.toThrow(/requires direct human interaction/);
    expect(uiMock.client.stopCodingAgent).not.toHaveBeenCalled();
  });

  it("refuses every human-only orchestrator capability", async () => {
    for (const capability of HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS) {
      await expect(
        interact(capability, { taskId: "task-1", sessionId: "session-1" }),
      ).rejects.toThrow(/requires direct human interaction/);
    }
    expect(uiMock.client.stopCodingAgent).not.toHaveBeenCalled();
  });

  it("names the task reads as reads", () => {
    const ids = [
      ...viewCapabilities("orchestrator"),
      ...viewCapabilities("task-coordinator"),
    ].map((capability) => capability.id);
    expect(ids).toContain("orchestrator-get-task");
    expect(ids).toContain("get-thread");
    expect(ids).not.toContain("orchestrator-open-task");
    expect(ids).not.toContain("open-thread");
  });

  it("renders terminal controls that stop or write as human authority", () => {
    const markup = renderToStaticMarkup(
      createElement(PtyConsoleBase, {
        activeSessionId: "session-1",
        sessions: [],
        variant: "full",
        onClose: () => {},
      }),
    );
    for (const id of HUMAN_ONLY_TERMINAL_CONTROL_IDS) {
      const tag = markup.match(
        new RegExp(`<[^>]*data-agent-human-id="${id}"[^>]*>`),
      )?.[0];
      expect(tag, id).toBeDefined();
      expect(tag).toContain('data-agent-authority="human"');
      expect(tag).not.toContain("data-agent-id=");
      expect(uiMock.agentElementIds).not.toContain(id);
    }
    expect(uiMock.agentElementIds).toEqual(["cockpit-terminal-panel-close"]);
    expect(markup).toContain("Connecting to terminal…");
    expect(markup).not.toContain("\u001b");
  });
});
