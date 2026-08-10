/**
 * Canonical official Google Workspace MCP resource catalog and curated tool
 * policy shared by local and Cloud execution hosts. Credentials never appear
 * here: callers resolve a binding to a short-lived bearer immediately before
 * calling the official resource URL.
 *
 * The capability→scope tables are the single source of truth: each product's
 * accepted scopes are derived from the capabilities its curated tools map to,
 * so the two can never drift.
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

export const GOOGLE_WORKSPACE_MCP_PRODUCTS = Object.keys(
  GOOGLE_WORKSPACE_MCP_ENDPOINTS,
) as readonly GoogleWorkspaceMcpProduct[];

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

/**
 * Least-privilege scopes the OAuth flow requests for each capability. Every
 * entry must be a subset of the matching GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES
 * list; the broader entries there additionally accept legacy grants.
 */
export const GOOGLE_WORKSPACE_MCP_CAPABILITY_REQUEST_SCOPES: Record<
  GoogleWorkspaceMcpCapability,
  readonly string[]
> = {
  "gmail.read": ["https://www.googleapis.com/auth/gmail.readonly"],
  "gmail.draft": ["https://www.googleapis.com/auth/gmail.compose"],
  "gmail.manage": ["https://www.googleapis.com/auth/gmail.modify"],
  "calendar.read": ["https://www.googleapis.com/auth/calendar.readonly"],
  "drive.read": ["https://www.googleapis.com/auth/drive.readonly"],
  "drive.write": ["https://www.googleapis.com/auth/drive.file"],
  "docs.read": ["https://www.googleapis.com/auth/documents.readonly"],
  "docs.write": ["https://www.googleapis.com/auth/documents"],
  "sheets.read": ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  "sheets.write": ["https://www.googleapis.com/auth/spreadsheets"],
  "slides.read": ["https://www.googleapis.com/auth/presentations.readonly"],
  "slides.write": ["https://www.googleapis.com/auth/presentations"],
  "chat.read": [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  ],
  "chat.send": ["https://www.googleapis.com/auth/chat.messages.create"],
  "people.read": [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  "workspace.search": UNIVERSAL_SEARCH_SCOPES,
};

const CALENDAR_EVENT_READ_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar",
] as const;

type GoogleWorkspaceMcpToolMap = Record<string, GoogleWorkspaceMcpCapability>;

const scopeUnion = (tools: GoogleWorkspaceMcpToolMap): readonly string[] => [
  ...new Set(
    Object.values(tools).flatMap(
      (capability) => GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES[capability],
    ),
  ),
];

const productResource = <
  const K extends GoogleWorkspaceMcpProduct,
  const D extends {
    promotedTools: readonly string[];
    tools: GoogleWorkspaceMcpToolMap;
    toolScopes?: Record<string, readonly string[]>;
  },
>(
  key: K,
  definition: D,
) => ({
  endpoint: GOOGLE_WORKSPACE_MCP_ENDPOINTS[key],
  acceptedScopes: scopeUnion(definition.tools),
  ...definition,
});

export const GOOGLE_WORKSPACE_MCP_RESOURCES = {
  gmail: productResource("gmail", {
    promotedTools: [
      "create_draft",
      "get_message",
      "get_thread",
      "search_threads",
    ],
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
  }),
  calendar: productResource("calendar", {
    promotedTools: ["list_events"],
    toolScopes: {
      list_events: CALENDAR_EVENT_READ_SCOPES,
      get_event: CALENDAR_EVENT_READ_SCOPES,
      list_calendars: [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist",
        "https://www.googleapis.com/auth/calendar",
      ],
      search_events: CALENDAR_EVENT_READ_SCOPES,
      suggest_time: [
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.freebusy",
        ...CALENDAR_EVENT_READ_SCOPES,
      ],
    },
    tools: {
      list_events: "calendar.read",
      get_event: "calendar.read",
      list_calendars: "calendar.read",
      search_events: "calendar.read",
      suggest_time: "calendar.read",
    },
  }),
  drive: productResource("drive", {
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
  }),
  docs: productResource("docs", {
    promotedTools: ["read_doc"],
    tools: { read_doc: "docs.read", update_doc: "docs.write" },
  }),
  sheets: productResource("sheets", {
    promotedTools: ["get_values"],
    tools: {
      get_values: "sheets.read",
      get_spreadsheet: "sheets.read",
      update_spreadsheet: "sheets.write",
      update_values: "sheets.write",
      update_formulas: "sheets.write",
      insert_dimension: "sheets.write",
    },
  }),
  slides: productResource("slides", {
    promotedTools: ["read_presentation"],
    tools: {
      read_presentation: "slides.read",
      update_presentation: "slides.write",
    },
  }),
  chat: productResource("chat", {
    promotedTools: ["search_messages"],
    tools: {
      list_messages: "chat.read",
      search_messages: "chat.read",
      search_conversations: "chat.read",
      send_message: "chat.send",
    },
  }),
  people: productResource("people", {
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
  }),
  universalSearch: productResource("universalSearch", {
    promotedTools: ["search_corpus"],
    tools: { search_corpus: "workspace.search" },
  }),
} as const;

export type GoogleWorkspaceMcpResourceProduct =
  keyof typeof GOOGLE_WORKSPACE_MCP_RESOURCES;

/** Human-readable product names shared by connector UI surfaces. */
export const GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS: Record<
  GoogleWorkspaceMcpProduct,
  string
> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
  docs: "Docs",
  sheets: "Sheets",
  slides: "Slides",
  chat: "Google Chat",
  people: "People",
  universalSearch: "Workspace search",
};

/**
 * Resolves a stored or user-supplied product identifier to the canonical
 * catalog key. Accepts any casing plus the legacy "workspace" alias for
 * universal search; returns undefined for products outside the catalog.
 */
export function canonicalGoogleMcpProduct(
  value: string,
): GoogleWorkspaceMcpProduct | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "workspace") return "universalSearch";
  return GOOGLE_WORKSPACE_MCP_PRODUCTS.find(
    (product) => product.toLowerCase() === normalized,
  );
}

/** Stable capability set a product's curated tools map to, in catalog order. */
export function googleMcpProductCapabilities(
  product: GoogleWorkspaceMcpProduct,
): GoogleWorkspaceMcpCapability[] {
  const tools: GoogleWorkspaceMcpToolMap =
    GOOGLE_WORKSPACE_MCP_RESOURCES[product].tools;
  return [...new Set(Object.values(tools))];
}

/**
 * Scopes that authorize one curated tool: the per-tool override when the
 * product declares one, otherwise the tool's capability scopes. Returns
 * undefined for tools outside the curated catalog.
 */
export function googleMcpToolScopes(
  product: GoogleWorkspaceMcpProduct,
  tool: string,
): readonly string[] | undefined {
  const resource = GOOGLE_WORKSPACE_MCP_RESOURCES[product];
  const tools: GoogleWorkspaceMcpToolMap = resource.tools;
  const capability = tools[tool];
  if (!capability) return undefined;
  const toolScopes: Record<string, readonly string[] | undefined> =
    "toolScopes" in resource ? resource.toolScopes : {};
  return toolScopes[tool] ?? GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES[capability];
}
