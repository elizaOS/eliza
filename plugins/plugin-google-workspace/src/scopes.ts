/**
 * OAuth capability and scope catalog for personal Google Workspace MCP
 * resources. Capabilities describe product permissions; execution always uses
 * official Google MCP tools and never a direct Google REST client.
 */
import {
  GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES,
  type GoogleWorkspaceMcpCapability,
} from "@elizaos/shared/contracts";

export type GoogleCapability = GoogleWorkspaceMcpCapability;

export const GOOGLE_CAPABILITIES = Object.keys(
  GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES
) as readonly GoogleCapability[];

export const GOOGLE_CAPABILITY_GROUPS = [
  "gmail",
  "calendar",
  "drive",
  "docs",
  "sheets",
  "slides",
  "chat",
  "people",
  "workspace",
] as const;

export type GoogleCapabilityGroup = (typeof GOOGLE_CAPABILITY_GROUPS)[number];

export const GOOGLE_OAUTH_SCOPES = {
  gmail: {
    read: "https://www.googleapis.com/auth/gmail.readonly",
    compose: "https://www.googleapis.com/auth/gmail.compose",
    manage: "https://www.googleapis.com/auth/gmail.modify",
  },
  calendar: {
    read: "https://www.googleapis.com/auth/calendar.readonly",
  },
  drive: {
    read: "https://www.googleapis.com/auth/drive.readonly",
    write: "https://www.googleapis.com/auth/drive.file",
  },
  docs: {
    read: "https://www.googleapis.com/auth/documents.readonly",
    write: "https://www.googleapis.com/auth/documents",
  },
  sheets: {
    read: "https://www.googleapis.com/auth/spreadsheets.readonly",
    write: "https://www.googleapis.com/auth/spreadsheets",
  },
  slides: {
    read: "https://www.googleapis.com/auth/presentations.readonly",
    write: "https://www.googleapis.com/auth/presentations",
  },
  chat: {
    readMessages: "https://www.googleapis.com/auth/chat.messages.readonly",
    readSpaces: "https://www.googleapis.com/auth/chat.spaces.readonly",
    readMemberships: "https://www.googleapis.com/auth/chat.memberships.readonly",
    readState: "https://www.googleapis.com/auth/chat.users.readstate.readonly",
    send: "https://www.googleapis.com/auth/chat.messages.create",
  },
  people: {
    contacts: "https://www.googleapis.com/auth/contacts.readonly",
    directory: "https://www.googleapis.com/auth/directory.readonly",
  },
  profile: {
    email: "https://www.googleapis.com/auth/userinfo.email",
    profile: "https://www.googleapis.com/auth/userinfo.profile",
    openid: "openid",
  },
} as const;

export const GOOGLE_CAPABILITY_SCOPES = {
  "gmail.read": [GOOGLE_OAUTH_SCOPES.gmail.read],
  "gmail.draft": [GOOGLE_OAUTH_SCOPES.gmail.compose],
  "gmail.manage": [GOOGLE_OAUTH_SCOPES.gmail.manage],
  "calendar.read": [GOOGLE_OAUTH_SCOPES.calendar.read],
  "drive.read": [GOOGLE_OAUTH_SCOPES.drive.read],
  "drive.write": [GOOGLE_OAUTH_SCOPES.drive.write],
  "docs.read": [GOOGLE_OAUTH_SCOPES.docs.read],
  "docs.write": [GOOGLE_OAUTH_SCOPES.docs.write],
  "sheets.read": [GOOGLE_OAUTH_SCOPES.sheets.read],
  "sheets.write": [GOOGLE_OAUTH_SCOPES.sheets.write],
  "slides.read": [GOOGLE_OAUTH_SCOPES.slides.read],
  "slides.write": [GOOGLE_OAUTH_SCOPES.slides.write],
  "chat.read": [
    GOOGLE_OAUTH_SCOPES.chat.readMessages,
    GOOGLE_OAUTH_SCOPES.chat.readSpaces,
    GOOGLE_OAUTH_SCOPES.chat.readMemberships,
    GOOGLE_OAUTH_SCOPES.chat.readState,
  ],
  "chat.send": [GOOGLE_OAUTH_SCOPES.chat.send, GOOGLE_OAUTH_SCOPES.chat.readSpaces],
  "people.read": [GOOGLE_OAUTH_SCOPES.people.contacts, GOOGLE_OAUTH_SCOPES.people.directory],
  "workspace.search": [
    GOOGLE_OAUTH_SCOPES.gmail.read,
    GOOGLE_OAUTH_SCOPES.calendar.read,
    GOOGLE_OAUTH_SCOPES.drive.read,
    GOOGLE_OAUTH_SCOPES.chat.readMessages,
  ],
} as const satisfies Record<GoogleCapability, readonly string[]>;

/**
 * Provider-returned scopes that authorize stable capabilities. This is wider
 * than the request catalog only for compatible existing grants; OAuth starts
 * continue to derive their scopes exclusively from `GOOGLE_CAPABILITY_SCOPES`.
 */
export const GOOGLE_CAPABILITY_AUTHORIZATION_SCOPES = GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES;

export const GOOGLE_IDENTITY_SCOPES = [
  GOOGLE_OAUTH_SCOPES.profile.openid,
  GOOGLE_OAUTH_SCOPES.profile.email,
  GOOGLE_OAUTH_SCOPES.profile.profile,
] as const;

const GOOGLE_CAPABILITY_SET = new Set<string>(GOOGLE_CAPABILITIES);

export function isGoogleCapability(value: unknown): value is GoogleCapability {
  return typeof value === "string" && GOOGLE_CAPABILITY_SET.has(value);
}

export function normalizeGoogleCapabilities(
  capabilities: Iterable<unknown> | undefined
): GoogleCapability[] {
  return [...new Set([...(capabilities ?? [])].filter(isGoogleCapability))];
}

export function scopesForGoogleCapabilities(
  capabilities: readonly GoogleCapability[],
  options: { includeIdentityScopes?: boolean } = {}
): string[] {
  const selected = new Set<string>(
    options.includeIdentityScopes === false ? [] : GOOGLE_IDENTITY_SCOPES
  );
  for (const capability of normalizeGoogleCapabilities(capabilities)) {
    for (const scope of GOOGLE_CAPABILITY_SCOPES[capability]) selected.add(scope);
  }
  return [...selected];
}
