/** Deterministic checks of the runtime-result to chat-client handoff boundary. */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { summarizeRuntimeActionResults } from "../chat-routes";

describe("chat action-result summaries", () => {
  it.each(["planner-data", "action-values"] as const)(
    "retains workspace navigation before a later page read from %s",
    (projection) => {
      const navigationValues = {
        success: true,
        mode: "web",
        targetId: "workspace",
        subaction: "navigate",
        viewId: "browser",
        viewPath: "/browser",
        tabId: "btab_1",
        url: "https://example.com/",
        title: "example.com",
      };
      const readValues = {
        success: true,
        mode: "web",
        targetId: "workspace",
        subaction: "get",
      };
      const results = [
        {
          success: true,
          text: "Opened example.com.",
          data: {
            actionName: "BROWSER_NAVIGATE",
            ...(projection === "planner-data"
              ? { values: navigationValues }
              : {}),
          },
          ...(projection === "action-values"
            ? { values: navigationValues }
            : {}),
        },
        {
          success: true,
          text: "Browser get result (web):\nExample Domain",
          data: {
            actionName: "BROWSER",
            ...(projection === "planner-data" ? { values: readValues } : {}),
          },
          ...(projection === "action-values" ? { values: readValues } : {}),
        },
      ];
      expect(
        JSON.parse(
          JSON.stringify(
            summarizeRuntimeActionResults(
              {} as AgentRuntime,
              undefined,
              results,
            ),
          ),
        ),
      ).toEqual([
        {
          actionName: "BROWSER_NAVIGATE",
          success: true,
          text: "Opened example.com.",
          values: navigationValues,
        },
        {
          actionName: "BROWSER",
          success: true,
          text: "Browser get result (web):\nExample Domain",
          values: readValues,
        },
      ]);
    },
  );

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
