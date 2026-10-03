/** Proves structured renderer metadata gives Stage 1 enough context for model-owned view follow-ups. */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { uiContextProvider } from "./uiContext.ts";

describe("UI_CONTEXT", () => {
  it("renders focused-view identity, path, and capability hints", async () => {
    const result = await uiContextProvider.get(
      {} as IAgentRuntime,
      {
        content: {
          metadata: {
            uiView: "notes",
            uiTab: "views",
            uiViewSubview: "general",
            uiViewPath: "/notes",
            uiViewCapabilities: ["view-actions", "inspect-view"],
            uiViewActionNames: ["NOTES"],
            __responseContext: {
              primaryContext: "apps",
              secondaryContexts: ["general"],
            },
          },
        },
      } as Memory,
      { values: {}, data: {}, text: "" } as State,
    );

    expect(result.text).toContain("view: notes");
    expect(result.text).toContain("path: /notes");
    expect(result.text).toContain("subview_id: general");
    expect(result.text).toContain(
      "view_capabilities: view-actions, inspect-view",
    );
    expect(result.text).toContain("view_actions: NOTES");
    expect(result.text).toContain(
      "view_capabilities is context, not an invocation request",
    );
    expect(result.text).toContain(
      "not displayed content or current record values",
    );
    expect(result.text).toContain("Opening is not a record operation");
    expect(result.data).toEqual({
      uiView: "notes",
      uiTab: "views",
      uiViewSubview: "general",
      uiViewPath: "/notes",
      uiViewCapabilities: ["view-actions", "inspect-view"],
      uiViewActionNames: ["NOTES"],
      activeContexts: ["apps", "general"],
    });
    expect(result.values).toEqual({
      uiView: "notes",
      uiTab: "views",
      uiViewSubview: "general",
      uiViewPath: "/notes",
      uiViewCapabilities: "view-actions, inspect-view",
      uiViewActionNames: "NOTES",
      uiContexts: "apps, general",
    });
  });

  it("keeps view capabilities separate from callable operations", async () => {
    const result = await uiContextProvider.get(
      {} as IAgentRuntime,
      {
        content: {
          metadata: {
            uiView: "calendar",
            uiViewCapabilities: [
              "get-text",
              "list-elements",
              "get-agent-state",
            ],
            uiViewActionNames: ["CALENDAR", "VIEW_CALENDAR_SELECT_VISIBLE_DAY"],
          },
        },
      } as Memory,
      { values: {}, data: {}, text: "" } as State,
    );
    expect(result.text).toContain(
      "view_capabilities: get-text, list-elements, get-agent-state",
    );
    expect(result.text).toContain(
      "view_actions: CALENDAR, VIEW_CALENDAR_SELECT_VISIBLE_DAY",
    );
    expect(result.text).toContain(
      "Discover views with VIEWS_LIST or VIEWS list",
    );
    expect(result.text).toContain(
      "open with VIEWS_SHOW or VIEWS show when registered",
    );
    expect(result.text).toContain("registered scoped action");
    expect(result.text).toContain("relevant domain read action");
    expect(result.text).toContain(
      "not displayed content or current record values",
    );
    expect(result.text).toContain(
      "Capability names and element IDs are not standalone tools",
    );
    expect(result.text).not.toContain("VIEWS get-text/list-elements");
    expect(result.text).not.toContain("Use VIEWS for layout");
    expect(result.data).toMatchObject({
      uiViewCapabilities: ["get-text", "list-elements", "get-agent-state"],
      uiViewActionNames: ["CALENDAR", "VIEW_CALENDAR_SELECT_VISIBLE_DAY"],
    });
  });

  it("stays silent without renderer or routing context", async () => {
    const result = await uiContextProvider.get(
      {} as IAgentRuntime,
      { content: {} } as Memory,
      { values: {}, data: {}, text: "" } as State,
    );
    expect(result.text).toBe("");
  });
});
