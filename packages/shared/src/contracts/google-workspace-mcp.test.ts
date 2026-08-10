/**
 * Contract coverage for the reviewed official Google Workspace MCP endpoint,
 * tool, and scope manifest shared by local and Cloud connector hosts.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalGoogleMcpProduct,
  GOOGLE_WORKSPACE_MCP_CAPABILITY_REQUEST_SCOPES,
  GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES,
  GOOGLE_WORKSPACE_MCP_ENDPOINTS,
  GOOGLE_WORKSPACE_MCP_RESOURCES,
  googleMcpToolScopes,
} from "./google-workspace-mcp.js";

describe("Google Workspace MCP manifest", () => {
  it("uses only official product-specific HTTPS resources", () => {
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
    for (const endpoint of Object.values(GOOGLE_WORKSPACE_MCP_ENDPOINTS)) {
      const url = new URL(endpoint);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toMatch(/(?:^|\.)googleapis\.com$/);
    }
  });

  it("models Gmail draft creation without inventing a send tool", () => {
    expect(GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.tools).toMatchObject({
      create_draft: "gmail.draft",
      search_threads: "gmail.read",
      label_thread: "gmail.manage",
    });
    expect(
      Object.keys(GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.tools),
    ).not.toContain("send_email");
    expect(
      Object.keys(GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.tools),
    ).not.toContain("apply_sensitive_thread_label");
    expect(GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES["gmail.draft"]).toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
  });

  it("keeps unsupported Calendar watches and Meet APIs out of the catalog", () => {
    expect(
      Object.keys(GOOGLE_WORKSPACE_MCP_RESOURCES.calendar.tools),
    ).not.toContain("watch_events");
    expect(GOOGLE_WORKSPACE_MCP_ENDPOINTS).not.toHaveProperty("meet");
  });

  it("promotes only the reviewed thirteen-tool action catalog", () => {
    const promoted = Object.values(GOOGLE_WORKSPACE_MCP_RESOURCES).flatMap(
      (resource) => resource.promotedTools,
    );
    expect(promoted).toHaveLength(13);
    expect(promoted).toContain("create_draft");
    expect(promoted).toContain("get_message");
    expect(promoted).not.toContain("send_message");
    for (const resource of Object.values(GOOGLE_WORKSPACE_MCP_RESOURCES)) {
      expect(
        resource.promotedTools.every((tool) => tool in resource.tools),
      ).toBe(true);
    }
  });

  it("does not treat compose-only Gmail consent as message-read consent", () => {
    expect(GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES["gmail.read"]).not.toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
    expect(
      GOOGLE_WORKSPACE_MCP_RESOURCES.calendar.toolScopes.list_calendars,
    ).toContain(
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    );
  });

  it("accepts legacy Calendar grants only as read authorization", () => {
    expect(GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES["calendar.read"]).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
      ]),
    );
    expect(Object.keys(GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES)).not.toContain(
      "calendar.write",
    );
    expect(GOOGLE_WORKSPACE_MCP_RESOURCES.calendar.tools).not.toHaveProperty(
      "create_event",
    );
    expect(
      GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES["workspace.search"],
    ).not.toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
      ]),
    );
  });

  it("requests only scopes each capability also accepts", () => {
    for (const [capability, requested] of Object.entries(
      GOOGLE_WORKSPACE_MCP_CAPABILITY_REQUEST_SCOPES,
    )) {
      const accepted =
        GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES[
          capability as keyof typeof GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES
        ];
      expect(accepted).toEqual(expect.arrayContaining([...requested]));
    }
  });

  it("resolves product aliases and per-tool scopes", () => {
    expect(canonicalGoogleMcpProduct("workspace")).toBe("universalSearch");
    expect(canonicalGoogleMcpProduct("UniversalSearch")).toBe(
      "universalSearch",
    );
    expect(canonicalGoogleMcpProduct("Gmail")).toBe("gmail");
    expect(canonicalGoogleMcpProduct("meet")).toBeUndefined();
    expect(googleMcpToolScopes("calendar", "list_events")).toContain(
      "https://www.googleapis.com/auth/calendar.events.readonly",
    );
    expect(googleMcpToolScopes("gmail", "create_draft")).toEqual(
      GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES["gmail.draft"],
    );
    expect(googleMcpToolScopes("gmail", "send_email")).toBeUndefined();
  });
});
