/**
 * Cross-host Google Workspace MCP endpoint and canary policy. The endpoint
 * catalog records Google's product split; the executable manifest stays
 * intentionally smaller so local and Cloud hosts enforce the same reviewed
 * capabilities, scopes, and tool names during Developer Preview.
 */

export const GOOGLE_WORKSPACE_MCP_ENDPOINTS = {
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  calendar: "https://calendarmcp.googleapis.com/mcp/v1",
  drive: "https://drivemcp.googleapis.com/mcp/v1",
  docs: "https://docsmcp.googleapis.com/mcp/v1",
  sheets: "https://sheetsmcp.googleapis.com/mcp/v1",
  slides: "https://slidesmcp.googleapis.com/mcp/v1",
  chat: "https://chatmcp.googleapis.com/mcp/v1",
  people: "https://people.googleapis.com/mcp/v1",
  universalSearch: "https://workspacemcp.googleapis.com/mcp/v1",
} as const;

export type GoogleWorkspaceMcpProduct =
  keyof typeof GOOGLE_WORKSPACE_MCP_ENDPOINTS;

export const GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES = {
  gmail: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.gmail,
    capability: "gmail.read",
    acceptedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://mail.google.com/",
    ],
    curatedTools: ["search_threads"],
  },
  calendar: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.calendar,
    capability: "calendar.read",
    acceptedScopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar",
    ],
    curatedTools: ["list_events"],
  },
} as const;

export type GoogleWorkspaceMcpCanaryProduct =
  keyof typeof GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES;
