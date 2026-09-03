import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@elizaos/core";
import { summarizeRuntimeActionResults } from "../chat-routes";

describe("chat action-result summaries", () => {
  it("preserves values projected under planner result data", () => {
    expect(
      summarizeRuntimeActionResults({} as AgentRuntime, undefined, [
        {
          success: true,
          text: "Opened example.com.",
          data: {
            actionName: "BROWSER_NAVIGATE",
            values: {
              targetId: "workspace",
              subaction: "navigate",
              viewId: "browser",
              viewPath: "/browser",
            },
          },
        },
      ]),
    ).toEqual([
      {
        actionName: "BROWSER_NAVIGATE",
        success: true,
        text: "Opened example.com.",
        values: {
          targetId: "workspace",
          subaction: "navigate",
          viewId: "browser",
          viewPath: "/browser",
        },
      },
    ]);
  });
});
