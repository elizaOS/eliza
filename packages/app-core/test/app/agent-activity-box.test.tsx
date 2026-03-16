import type { CodingAgentSession } from "@elizaos/app-core/api";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { AgentActivityBox } from "../../src/components/AgentActivityBox";

function makeSession(
  overrides: Partial<CodingAgentSession> = {},
): CodingAgentSession {
  return {
    sessionId: "s-1",
    label: "my-task",
    agentType: "claude",
    status: "active",
    decisionCount: 0,
    autoResolvedCount: 0,
    ...overrides,
  };
}

describe("AgentActivityBox", () => {
  it("renders nothing when no sessions", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(AgentActivityBox, { sessions: [] }),
      );
    });
    expect(tree.toJSON()).toBeNull();
  });

  it("renders a row per session with label and activity", () => {
    const sessions = [
      makeSession({
        sessionId: "s-1",
        label: "task-a",
        lastActivity: "Running Write",
      }),
      makeSession({
        sessionId: "s-2",
        label: "task-b",
        status: "blocked",
        lastActivity: "Waiting for input",
      }),
    ];
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(AgentActivityBox, { sessions }),
      );
    });

    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("task-a");
    expect(json).toContain("task-b");
    expect(json).toContain("Running Write");
    expect(json).toContain("Waiting for input");
  });

  it("derives activity from status when lastActivity is absent", () => {
    const sessions = [
      makeSession({ status: "tool_running", toolDescription: "Bash" }),
    ];
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(AgentActivityBox, { sessions }),
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Running Bash");
  });

  it("shows pulsing dot for active/tool_running statuses", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(AgentActivityBox, {
          sessions: [makeSession({ status: "active" })],
        }),
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("animate-pulse");
  });

  it("does not pulse for blocked/error statuses", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(AgentActivityBox, {
          sessions: [makeSession({ status: "blocked" })],
        }),
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).not.toContain("animate-pulse");
  });

  it("uses correct status dot colors", () => {
    let active!: TestRenderer.ReactTestRenderer;
    let error!: TestRenderer.ReactTestRenderer;
    let blocked!: TestRenderer.ReactTestRenderer;

    act(() => {
      active = TestRenderer.create(
        React.createElement(AgentActivityBox, {
          sessions: [makeSession({ status: "active" })],
        }),
      );
    });
    expect(JSON.stringify(active.toJSON())).toContain("bg-ok");

    act(() => {
      error = TestRenderer.create(
        React.createElement(AgentActivityBox, {
          sessions: [makeSession({ status: "error" })],
        }),
      );
    });
    expect(JSON.stringify(error.toJSON())).toContain("bg-danger");

    act(() => {
      blocked = TestRenderer.create(
        React.createElement(AgentActivityBox, {
          sessions: [makeSession({ status: "blocked" })],
        }),
      );
    });
    expect(JSON.stringify(blocked.toJSON())).toContain("bg-warn");
  });
});
