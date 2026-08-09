/**
 * Drift guard for the cross-host Google Workspace MCP catalog and executable
 * canary. It prevents a host from accidentally collapsing Google into one URL
 * or promoting an unreviewed preview product/tool through the shared policy.
 */

import { describe, expect, test } from "vitest";
import {
  GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES,
  GOOGLE_WORKSPACE_MCP_ENDPOINTS,
} from "./google-workspace-mcp";

describe("Google Workspace MCP shared contract", () => {
  test("keeps all official product resources distinct", () => {
    expect(GOOGLE_WORKSPACE_MCP_ENDPOINTS).toEqual({
      gmail: "https://gmailmcp.googleapis.com/mcp/v1",
      calendar: "https://calendarmcp.googleapis.com/mcp/v1",
      drive: "https://drivemcp.googleapis.com/mcp/v1",
      docs: "https://docsmcp.googleapis.com/mcp/v1",
      sheets: "https://sheetsmcp.googleapis.com/mcp/v1",
      slides: "https://slidesmcp.googleapis.com/mcp/v1",
      chat: "https://chatmcp.googleapis.com/mcp/v1",
      people: "https://people.googleapis.com/mcp/v1",
      universalSearch: "https://workspacemcp.googleapis.com/mcp/v1",
    });
    expect(new Set(Object.values(GOOGLE_WORKSPACE_MCP_ENDPOINTS)).size).toBe(9);
  });

  test("limits executable preview policy to one reviewed read tool per canary product", () => {
    expect(Object.keys(GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES)).toEqual([
      "gmail",
      "calendar",
    ]);
    expect(GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.curatedTools).toEqual([
      "search_threads",
    ]);
    expect(GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.curatedTools).toEqual(
      ["list_events"],
    );
    expect(
      GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.acceptedScopes,
    ).not.toContain("https://www.googleapis.com/auth/gmail.metadata");
  });
});
