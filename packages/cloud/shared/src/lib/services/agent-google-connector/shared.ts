// Coordinates cloud service shared behavior behind route handlers.
import { and, eq } from "drizzle-orm";
import { dbRead } from "../../../db/client";
import { platformCredentials } from "../../../db/schemas/platform-credentials";
import { googleFetchWithToken } from "../../utils/google-mcp-shared";
import { oauthService } from "../oauth";
import { getPreferredActiveConnection } from "../oauth/oauth-service";
import { getProvider, isProviderConfigured } from "../oauth/provider-registry";
import type { OAuthConnectionRole } from "../oauth/types";

const DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES = [
  "google.basic_identity",
  "google.calendar.read",
  "google.gmail.triage",
  "google.gmail.send",
] as const;

export type AgentGoogleCapability =
  | "google.basic_identity"
  | "google.calendar.read"
  | "google.calendar.write"
  | "google.gmail.triage"
  | "google.gmail.send"
  | "google.gmail.manage";

export interface ManagedGoogleConnectorStatus {
  provider: "google";
  side: OAuthConnectionRole;
  mode: "cloud_managed";
  configured: boolean;
  connected: boolean;
  reason: "connected" | "disconnected" | "config_missing" | "token_missing" | "needs_reauth";
  identity: Record<string, unknown> | null;
  grantedCapabilities: AgentGoogleCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectionId: string | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
}

export interface ManagedGoogleCalendarEvent {
  externalId: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: Array<{
    email: string | null;
    displayName: string | null;
    responseStatus: string | null;
    self: boolean;
    organizer: boolean;
    optional: boolean;
  }>;
  metadata: Record<string, unknown>;
}

export interface ManagedGoogleCalendarSummary {
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
}

export interface ManagedGoogleGmailMessage {
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isImportant: boolean;
  likelyReplyNeeded: boolean;
  triageScore: number;
  triageReason: string;
  labels: string[];
  htmlLink: string | null;
  metadata: Record<string, unknown>;
}

export interface ManagedGoogleGmailReadResult {
  message: ManagedGoogleGmailMessage;
  bodyText: string;
}

export interface ManagedGoogleGmailSearchResult {
  messages: ManagedGoogleGmailMessage[];
  syncedAt: string;
}

export interface ManagedGoogleGmailSubscriptionHeader {
  messageId: string;
  threadId: string;
  receivedAt: string;
  subject: string;
  fromDisplay: string;
  fromEmail: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  snippet: string;
  labels: string[];
}

export interface ManagedGoogleGmailSubscriptionHeadersResult {
  headers: ManagedGoogleGmailSubscriptionHeader[];
  syncedAt: string;
}

export class AgentGoogleConnectorError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentGoogleConnectorError";
  }
}

export type GoogleConnectionRow = typeof platformCredentials.$inferSelect;

type ManagedGoogleConnectorDeps = {
  dbRead: {
    select: typeof dbRead.select;
  };
  oauthService: {
    listConnections: typeof oauthService.listConnections;
    getValidToken: typeof oauthService.getValidToken;
    getValidTokenByPlatformWithConnectionId: typeof oauthService.getValidTokenByPlatformWithConnectionId;
    initiateAuth: typeof oauthService.initiateAuth;
    revokeConnection: typeof oauthService.revokeConnection;
  };
};

export const managedGoogleConnectorDeps: ManagedGoogleConnectorDeps = {
  dbRead,
  oauthService,
};

export function fail(status: number, message: string): never {
  throw new AgentGoogleConnectorError(status, message);
}

export function normalizeCapabilities(
  requested?: readonly AgentGoogleCapability[],
): AgentGoogleCapability[] {
  const source = requested ?? DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES;
  const normalized = [...new Set(source)];
  return normalized.includes("google.basic_identity")
    ? normalized
    : ["google.basic_identity", ...normalized];
}

export function capabilitiesToScopes(capabilities: readonly AgentGoogleCapability[]): string[] {
  const scopes = new Set<string>([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);

  for (const capability of normalizeCapabilities(capabilities)) {
    if (capability === "google.calendar.read") {
      scopes.add("https://www.googleapis.com/auth/calendar.readonly");
    }
    if (capability === "google.calendar.write") {
      scopes.add("https://www.googleapis.com/auth/calendar.events");
    }
    if (capability === "google.gmail.triage") {
      scopes.add("https://www.googleapis.com/auth/gmail.readonly");
    }
    if (capability === "google.gmail.send") {
      scopes.add("https://www.googleapis.com/auth/gmail.send");
    }
    if (capability === "google.gmail.manage") {
      scopes.add("https://www.googleapis.com/auth/gmail.modify");
      scopes.add("https://www.googleapis.com/auth/gmail.settings.basic");
    }
  }

  return [...scopes];
}

function scopesToCapabilities(scopes: readonly string[]): AgentGoogleCapability[] {
  const granted = new Set(scopes);
  const capabilities: AgentGoogleCapability[] = [];
  const hasIdentity =
    granted.has("openid") ||
    granted.has("email") ||
    granted.has("profile") ||
    granted.has("https://www.googleapis.com/auth/userinfo.email") ||
    granted.has("https://www.googleapis.com/auth/userinfo.profile");
  if (hasIdentity) {
    capabilities.push("google.basic_identity");
  }
  if (
    granted.has("https://www.googleapis.com/auth/calendar.readonly") ||
    granted.has("https://www.googleapis.com/auth/calendar.events") ||
    granted.has("https://www.googleapis.com/auth/calendar")
  ) {
    capabilities.push("google.calendar.read");
  }
  if (
    granted.has("https://www.googleapis.com/auth/calendar.events") ||
    granted.has("https://www.googleapis.com/auth/calendar")
  ) {
    capabilities.push("google.calendar.write");
  }
  if (
    granted.has("https://www.googleapis.com/auth/gmail.metadata") ||
    granted.has("https://www.googleapis.com/auth/gmail.readonly") ||
    granted.has("https://www.googleapis.com/auth/gmail.modify") ||
    granted.has("https://www.googleapis.com/auth/gmail.compose")
  ) {
    capabilities.push("google.gmail.triage");
  }
  if (granted.has("https://www.googleapis.com/auth/gmail.send")) {
    capabilities.push("google.gmail.send");
  }
  if (
    granted.has("https://www.googleapis.com/auth/gmail.modify") &&
    granted.has("https://www.googleapis.com/auth/gmail.settings.basic")
  ) {
    capabilities.push("google.gmail.manage");
  }
  return normalizeCapabilities(capabilities);
}

async function getConnectionRow(
  organizationId: string,
  connectionId: string,
): Promise<GoogleConnectionRow | null> {
  const [row] = await managedGoogleConnectorDeps.dbRead
    .select()
    .from(platformCredentials)
    .where(
      and(
        eq(platformCredentials.organization_id, organizationId),
        eq(platformCredentials.id, connectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getScopedGoogleConnections(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
}) {
  return managedGoogleConnectorDeps.oauthService.listConnections({
    organizationId: args.organizationId,
    userId: args.userId,
    platform: "google",
    connectionRole: args.side,
  });
}

async function getActiveGoogleConnectionRecord(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
}) {
  const connections = await getScopedGoogleConnections(args);
  const activeConnection = getPreferredActiveConnection(connections, args.userId, args.side);
  const latestConnection = connections[0] ?? null;
  const activeRow = activeConnection
    ? await getConnectionRow(args.organizationId, activeConnection.id)
    : null;
  const latestRow =
    latestConnection && latestConnection.id !== activeConnection?.id
      ? await getConnectionRow(args.organizationId, latestConnection.id)
      : activeRow;

  return {
    connections,
    activeConnection,
    latestConnection,
    activeRow,
    latestRow,
  };
}

export async function getGoogleAccessToken(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
}): Promise<{ accessToken: string; connectionId: string }> {
  try {
    if (args.grantId) {
      const connection = (
        await getScopedGoogleConnections({
          organizationId: args.organizationId,
          userId: args.userId,
          side: args.side,
        })
      ).find((candidate) => candidate.id === args.grantId);
      if (!connection) {
        fail(404, "Google connection not found.");
      }
      const token = await managedGoogleConnectorDeps.oauthService.getValidToken({
        organizationId: args.organizationId,
        connectionId: connection.id,
        platform: "google",
      });
      return {
        accessToken: token.accessToken,
        connectionId: connection.id,
      };
    }
    return await managedGoogleConnectorDeps.oauthService
      .getValidTokenByPlatformWithConnectionId({
        organizationId: args.organizationId,
        userId: args.userId,
        platform: "google",
        connectionRole: args.side,
      })
      .then((result) => ({
        accessToken: result.token.accessToken,
        connectionId: result.connectionId,
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(409, message);
  }
}

export async function googleFetch(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  url: string;
  options?: RequestInit;
}): Promise<Response> {
  const { accessToken } = await getGoogleAccessToken(args);
  try {
    return await googleFetchWithToken(accessToken, args.url, args.options);
  } catch (error) {
    fail(502, error instanceof Error ? error.message : String(error));
  }
}

function shapeConnectedStatus(
  side: OAuthConnectionRole,
  connection: NonNullable<Awaited<ReturnType<typeof getScopedGoogleConnections>>[number]>,
  row: GoogleConnectionRow | null,
): ManagedGoogleConnectorStatus {
  const connected = connection.status === "active";
  const reason = connected
    ? "connected"
    : connection.status === "expired" || connection.status === "error"
      ? "needs_reauth"
      : "disconnected";

  return {
    provider: "google",
    side,
    mode: "cloud_managed",
    configured: true,
    connected,
    reason,
    identity: {
      id: connection.platformUserId,
      email: connection.email ?? null,
      name: connection.displayName ?? connection.username ?? null,
      avatarUrl: connection.avatarUrl ?? null,
    },
    grantedCapabilities: scopesToCapabilities(connection.scopes),
    grantedScopes: [...connection.scopes],
    expiresAt: row?.token_expires_at?.toISOString() ?? null,
    hasRefreshToken: Boolean(row?.refresh_token_secret_id),
    connectionId: connection.id,
    linkedAt: connection.linkedAt.toISOString(),
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
  };
}

function emptyStatus(side: OAuthConnectionRole, configured: boolean): ManagedGoogleConnectorStatus {
  return {
    provider: "google",
    side,
    mode: "cloud_managed",
    configured,
    connected: false,
    reason: configured ? "disconnected" : "config_missing",
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    connectionId: null,
    linkedAt: null,
    lastUsedAt: null,
  };
}

export async function getManagedGoogleConnectorStatus(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
}): Promise<ManagedGoogleConnectorStatus> {
  const provider = getProvider("google");
  const configured = provider ? isProviderConfigured(provider) : false;

  if (!configured) {
    return emptyStatus(args.side, false);
  }

  if (args.grantId) {
    const connection =
      (
        await getScopedGoogleConnections({
          organizationId: args.organizationId,
          userId: args.userId,
          side: args.side,
        })
      ).find((candidate) => candidate.id === args.grantId) ?? null;
    if (!connection) {
      fail(404, "Google connection not found.");
    }
    const row = await getConnectionRow(args.organizationId, connection.id);
    return shapeConnectedStatus(args.side, connection, row);
  }

  const { activeConnection, latestConnection, activeRow, latestRow } =
    await getActiveGoogleConnectionRecord(args);
  const currentConnection = activeConnection ?? latestConnection ?? null;
  const currentRow = activeRow ?? latestRow ?? null;

  if (!currentConnection) {
    return emptyStatus(args.side, true);
  }

  return shapeConnectedStatus(args.side, currentConnection, currentRow);
}

export async function listManagedGoogleConnectorAccounts(args: {
  organizationId: string;
  userId: string;
  side?: OAuthConnectionRole;
}): Promise<ManagedGoogleConnectorStatus[]> {
  const sides: OAuthConnectionRole[] = args.side ? [args.side] : ["owner", "agent"];
  const results: ManagedGoogleConnectorStatus[] = [];

  for (const side of sides) {
    const connections = await getScopedGoogleConnections({
      organizationId: args.organizationId,
      userId: args.userId,
      side,
    });

    for (const connection of connections) {
      const row = await getConnectionRow(args.organizationId, connection.id);
      results.push(shapeConnectedStatus(side, connection, row));
    }
  }

  return results;
}

export async function initiateManagedGoogleConnection(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  redirectUrl?: string;
  capabilities?: AgentGoogleCapability[];
}) {
  const requestedCapabilities = normalizeCapabilities(args.capabilities);
  const auth = await managedGoogleConnectorDeps.oauthService.initiateAuth({
    organizationId: args.organizationId,
    userId: args.userId,
    platform: "google",
    redirectUrl: args.redirectUrl,
    scopes: capabilitiesToScopes(requestedCapabilities),
    connectionRole: args.side,
  });
  return {
    provider: "google" as const,
    side: args.side,
    mode: "cloud_managed" as const,
    requestedCapabilities,
    redirectUri: args.redirectUrl ?? "/auth/success?platform=google",
    authUrl: auth.authUrl,
  };
}

export async function disconnectManagedGoogleConnection(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  connectionId?: string | null;
}): Promise<void> {
  const connections = await getScopedGoogleConnections(args);
  const activeConnection =
    (args.connectionId
      ? connections.find((connection) => connection.id === args.connectionId)
      : getPreferredActiveConnection(connections, args.userId, args.side)) ??
    connections[0] ??
    null;
  if (!activeConnection) {
    return;
  }
  await managedGoogleConnectorDeps.oauthService.revokeConnection({
    organizationId: args.organizationId,
    connectionId: activeConnection.id,
  });
}
