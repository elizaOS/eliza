/**
 * Canonical official Google Workspace MCP resource catalog and curated tool
 * policy shared by local and Cloud execution hosts. Credentials never appear
 * here: callers resolve a binding to a short-lived bearer immediately before
 * calling the official resource URL.
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

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
] as const;

const CALENDAR_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

const CALENDAR_SCOPES = [
  ...CALENDAR_READONLY_SCOPES,
  // Existing connections may carry these legacy write-capable grants. They
  // authorize the stable read capability but are never requested by the new
  // least-privilege OAuth flow, and there is no Calendar write capability.
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar",
] as const;

const UNIVERSAL_SEARCH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
] as const;

export const GOOGLE_WORKSPACE_MCP_RESOURCES = {
  gmail: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.gmail,
    acceptedScopes: GMAIL_SCOPES,
    promotedTools: ["create_draft", "get_thread", "search_threads"],
    tools: {
      create_draft: "gmail.draft",
      list_drafts: "gmail.read",
      get_thread: "gmail.read",
      get_message: "gmail.read",
      search_threads: "gmail.read",
      label_thread: "gmail.manage",
      unlabel_thread: "gmail.manage",
      list_labels: "gmail.read",
      label_message: "gmail.manage",
      unlabel_message: "gmail.manage",
    },
  },
  calendar: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.calendar,
    acceptedScopes: CALENDAR_SCOPES,
    promotedTools: ["list_events"],
    toolScopes: {
      list_events: [
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
      ],
      get_event: [
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
      ],
      list_calendars: [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist",
        "https://www.googleapis.com/auth/calendar",
      ],
      search_events: [
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
      ],
      suggest_time: [
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.freebusy",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar",
      ],
    },
    tools: {
      list_events: "calendar.read",
      get_event: "calendar.read",
      list_calendars: "calendar.read",
      search_events: "calendar.read",
      suggest_time: "calendar.read",
    },
  },
  drive: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.drive,
    acceptedScopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive",
    ],
    promotedTools: ["read_file_content", "search_files"],
    tools: {
      get_file_metadata: "drive.read",
      get_file_permissions: "drive.read",
      list_recent_files: "drive.read",
      read_file_content: "drive.read",
      search_files: "drive.read",
      download_file_content: "drive.read",
      copy_file: "drive.write",
      create_file: "drive.write",
    },
  },
  docs: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.docs,
    acceptedScopes: [
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive",
    ],
    promotedTools: ["read_doc"],
    tools: { read_doc: "docs.read", update_doc: "docs.write" },
  },
  sheets: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.sheets,
    acceptedScopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive",
    ],
    promotedTools: ["get_values"],
    tools: {
      get_values: "sheets.read",
      get_spreadsheet: "sheets.read",
      update_spreadsheet: "sheets.write",
      update_values: "sheets.write",
      update_formulas: "sheets.write",
      insert_dimension: "sheets.write",
    },
  },
  slides: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.slides,
    acceptedScopes: [
      "https://www.googleapis.com/auth/presentations.readonly",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    promotedTools: ["read_presentation"],
    tools: {
      read_presentation: "slides.read",
      update_presentation: "slides.write",
    },
  },
  chat: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.chat,
    acceptedScopes: [
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/chat.messages.create",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.spaces",
      "https://www.googleapis.com/auth/chat.memberships.readonly",
      "https://www.googleapis.com/auth/chat.users.readstate.readonly",
    ],
    promotedTools: ["search_messages"],
    tools: {
      list_messages: "chat.read",
      search_messages: "chat.read",
      search_conversations: "chat.read",
      send_message: "chat.send",
    },
  },
  people: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.people,
    acceptedScopes: [
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    promotedTools: ["search_contacts"],
    toolScopes: {
      search_directory_people: [
        "https://www.googleapis.com/auth/directory.readonly",
      ],
      search_contacts: ["https://www.googleapis.com/auth/contacts.readonly"],
      get_user_profile: ["https://www.googleapis.com/auth/userinfo.profile"],
    },
    tools: {
      search_directory_people: "people.read",
      search_contacts: "people.read",
      get_user_profile: "people.read",
    },
  },
  universalSearch: {
    endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS.universalSearch,
    acceptedScopes: UNIVERSAL_SEARCH_SCOPES,
    promotedTools: ["search_corpus"],
    tools: { search_corpus: "workspace.search" },
  },
} as const;

export type GoogleWorkspaceMcpResourceProduct =
  keyof typeof GOOGLE_WORKSPACE_MCP_RESOURCES;

/** OAuth scopes that authorize each stable connector capability. */
export const GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES = {
  "gmail.read": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ],
  "gmail.draft": [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ],
  "gmail.manage": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ],
  "calendar.read": CALENDAR_SCOPES,
  "drive.read": [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive",
  ],
  "drive.write": [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive",
  ],
  "docs.read": [
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive",
  ],
  "docs.write": [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
  ],
  "sheets.read": [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive",
  ],
  "sheets.write": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
  "slides.read": [
    "https://www.googleapis.com/auth/presentations.readonly",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ],
  "slides.write": [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive.file",
  ],
  "chat.read": [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.spaces",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  ],
  "chat.send": [
    "https://www.googleapis.com/auth/chat.messages.create",
    "https://www.googleapis.com/auth/chat.messages",
  ],
  "people.read": [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  "workspace.search": UNIVERSAL_SEARCH_SCOPES,
} as const;

export type GoogleWorkspaceMcpCapability =
  keyof typeof GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES;

/** Compatibility alias for the first spike; new code uses the complete catalog. */
export const GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES = {
  gmail: {
    ...GOOGLE_WORKSPACE_MCP_RESOURCES.gmail,
    capability: "gmail.read",
    curatedTools: ["search_threads"],
  },
  calendar: {
    ...GOOGLE_WORKSPACE_MCP_RESOURCES.calendar,
    capability: "calendar.read",
    curatedTools: ["list_events"],
  },
} as const;

export type GoogleWorkspaceMcpCanaryProduct =
  keyof typeof GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES;
