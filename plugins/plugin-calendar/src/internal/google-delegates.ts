import {
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import type {
  GoogleCalendarEvent,
  GoogleCalendarEventInput,
  GoogleCalendarEventPatchInput,
  GoogleCalendarListEntry,
  GoogleEmailAddress,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventAttendee,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { fail } from "./errors.js";
import { normalizeGoogleCapabilities } from "./normalize.js";

export const GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX = "connector-account:";

type RuntimeWithService = Pick<IAgentRuntime, "getService">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function isoString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : value.trim();
  }
  return null;
}

function metadata(account: ConnectorAccount): Record<string, unknown> {
  return isRecord(account.metadata) ? account.metadata : {};
}

function mapCapability(value: string): LifeOpsGoogleCapability | null {
  switch (value) {
    case "google.basic_identity":
    case "basic_identity":
      return "google.basic_identity";
    case "google.calendar.read":
    case "calendar.read":
      return "google.calendar.read";
    case "google.calendar.write":
    case "calendar.write":
      return "google.calendar.write";
    case "google.gmail.triage":
    case "gmail.read":
      return "google.gmail.triage";
    case "google.gmail.send":
    case "gmail.send":
      return "google.gmail.send";
    case "google.gmail.manage":
    case "gmail.manage":
      return "google.gmail.manage";
    default:
      return null;
  }
}

export function googleAccountIdFromGrantId(
  grantId: string | undefined | null,
): string | null {
  const normalized = stringValue(grantId);
  if (!normalized) return null;
  return normalized.startsWith(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX)
    ? normalized.slice(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX.length)
    : normalized;
}

export function googleGrantIdForAccount(accountId: string): string {
  return `${GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX}${accountId}`;
}

export function googleSideForAccount(
  account: Pick<ConnectorAccount, "role">,
): LifeOpsConnectorSide {
  return account.role === "AGENT" ? "agent" : "owner";
}

function googleCapabilitiesForAccount(
  account: ConnectorAccount,
): LifeOpsGoogleCapability[] {
  const meta = metadata(account);
  const values = [
    ...stringArray(meta.grantedCapabilities),
    ...stringArray(meta.capabilities),
    ...stringArray(meta.googleCapabilities),
  ];
  const scopes = stringArray(meta.grantedScopes);
  if (scopes.some((scope) => scope.includes("calendar"))) {
    values.push("google.calendar.read");
  }
  if (scopes.some((scope) => scope.includes("calendar.events"))) {
    values.push("google.calendar.write");
  }
  if (scopes.some((scope) => scope.includes("gmail.readonly"))) {
    values.push("google.gmail.triage");
  }
  if (scopes.some((scope) => scope.includes("gmail.send"))) {
    values.push("google.gmail.send");
  }
  if (
    scopes.some(
      (scope) =>
        scope.includes("gmail.modify") || scope.includes("gmail.settings"),
    )
  ) {
    values.push("google.gmail.manage");
  }
  const normalized = new Set<LifeOpsGoogleCapability>([
    "google.basic_identity",
  ]);
  for (const value of values) {
    const mapped = mapCapability(value);
    if (mapped) normalized.add(mapped);
  }
  if (normalized.has("google.calendar.write")) {
    normalized.add("google.calendar.read");
  }
  if (normalized.has("google.gmail.send")) {
    normalized.add("google.gmail.triage");
  }
  if (normalized.has("google.gmail.manage")) {
    normalized.add("google.gmail.triage");
  }
  return normalizeGoogleCapabilities([
    ...normalized,
  ]) as LifeOpsGoogleCapability[];
}

function googleScopesForAccount(
  account: ConnectorAccount,
  capabilities = googleCapabilitiesForAccount(account),
): string[] {
  const scopes = stringArray(metadata(account).grantedScopes);
  if (scopes.length > 0) return scopes;
  const derived = new Set<string>([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);
  if (capabilities.includes("google.calendar.read")) {
    derived.add("https://www.googleapis.com/auth/calendar.readonly");
  }
  if (capabilities.includes("google.calendar.write")) {
    derived.add("https://www.googleapis.com/auth/calendar.events");
  }
  if (capabilities.includes("google.gmail.triage")) {
    derived.add("https://www.googleapis.com/auth/gmail.readonly");
  }
  if (capabilities.includes("google.gmail.send")) {
    derived.add("https://www.googleapis.com/auth/gmail.send");
  }
  if (capabilities.includes("google.gmail.manage")) {
    derived.add("https://www.googleapis.com/auth/gmail.modify");
    derived.add("https://www.googleapis.com/auth/gmail.settings.basic");
  }
  return [...derived];
}

function googleIdentityForAccount(
  account: ConnectorAccount,
): Record<string, unknown> | null {
  const meta = metadata(account);
  const identity = isRecord(meta.identity) ? { ...meta.identity } : {};
  const externalId = stringValue(account.externalId);
  const displayHandle = stringValue(account.displayHandle);
  if (externalId) identity.sub ??= externalId;
  if (displayHandle) identity.email ??= displayHandle;
  for (const key of ["email", "name", "picture", "locale"]) {
    const value = stringValue(meta[key]);
    if (value) identity[key] = value;
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function googleAccountEmail(account: ConnectorAccount): string | null {
  const identity = googleIdentityForAccount(account);
  return (
    (
      stringValue(identity?.email) ??
      stringValue(account.displayHandle) ??
      null
    )?.toLowerCase() ?? null
  );
}

function googleGrantFromAccount(args: {
  account: ConnectorAccount;
  agentId: string;
}): LifeOpsConnectorGrant {
  const { account, agentId } = args;
  const capabilities = googleCapabilitiesForAccount(account);
  const updatedAt = new Date(account.updatedAt).toISOString();
  const createdAt = new Date(account.createdAt).toISOString();
  const meta = metadata(account);
  return {
    id: googleGrantIdForAccount(account.id),
    agentId,
    provider: "google",
    connectorAccountId: account.id,
    side: googleSideForAccount(account),
    identity: googleIdentityForAccount(account) ?? {},
    identityEmail: googleAccountEmail(account),
    grantedScopes: googleScopesForAccount(account, capabilities),
    capabilities,
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: booleanValue(meta.isDefault),
    cloudConnectionId: null,
    metadata: {
      ...meta,
      connectorAccountId: account.id,
      connectorAccountProvider: "google",
    },
    lastRefreshAt: updatedAt,
    createdAt,
    updatedAt,
  };
}

export function googleStatusFromAccount(args: {
  account: ConnectorAccount;
  agentId: string;
  defaultMode?: LifeOpsConnectorMode;
  availableModes?: LifeOpsConnectorMode[];
}): LifeOpsGoogleConnectorStatus {
  const { account, agentId } = args;
  const grant = googleGrantFromAccount({ account, agentId });
  const meta = metadata(account);
  const connected = account.status === "connected";
  return {
    provider: "google",
    side: grant.side,
    mode: "local",
    defaultMode: args.defaultMode ?? "local",
    availableModes: args.availableModes ?? ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: true,
    connected,
    reason:
      account.status === "error" || account.status === "revoked"
        ? "needs_reauth"
        : connected
          ? "connected"
          : "disconnected",
    preferredByAgent: grant.preferredByAgent,
    cloudConnectionId: null,
    identity: googleIdentityForAccount(account),
    grantedCapabilities: [...grant.capabilities] as LifeOpsGoogleCapability[],
    grantedScopes: [...grant.grantedScopes],
    expiresAt: isoString(meta.expiresAt),
    hasRefreshToken:
      booleanValue(meta.hasRefreshToken) ||
      Boolean(stringValue(meta.refreshTokenRef)),
    grant,
  };
}

export function disconnectedGoogleStatus(
  side: LifeOpsConnectorSide,
): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side,
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: false,
    connected: false,
    reason: "disconnected",
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    grant: null,
    degradations: [
      {
        axis: "disconnected",
        code: "google_plugin_account_missing",
        message:
          "Connect a Google account through the Google connector account manager.",
        retryable: true,
      },
    ],
  };
}

export async function listGoogleConnectorAccounts(args: {
  runtime: IAgentRuntime;
  requestedSide?: LifeOpsConnectorSide;
}): Promise<ConnectorAccount[]> {
  const manager = getConnectorAccountManager(args.runtime);
  const accounts = await manager.listAccounts("google");
  return accounts
    .filter(
      (account) =>
        account.status !== "disabled" && account.status !== "revoked",
    )
    .filter((account) =>
      args.requestedSide
        ? googleSideForAccount(account) === args.requestedSide
        : true,
    );
}

export async function resolveGoogleConnectorAccount(args: {
  runtime: IAgentRuntime;
  requestedSide?: LifeOpsConnectorSide;
  grantId?: string | null;
}): Promise<ConnectorAccount | null> {
  const accountId = googleAccountIdFromGrantId(args.grantId);
  const accounts = await listGoogleConnectorAccounts({
    runtime: args.runtime,
    requestedSide: args.requestedSide,
  });
  if (accountId) {
    return (
      accounts.find(
        (account) =>
          account.id === accountId ||
          account.externalId === accountId ||
          account.displayHandle === accountId,
      ) ?? null
    );
  }
  return (
    accounts.find(
      (account) =>
        account.status === "connected" && metadata(account).isDefault === true,
    ) ??
    accounts.find((account) => account.status === "connected") ??
    accounts[0] ??
    null
  );
}

export function googleAccountStatus(args: {
  account: ConnectorAccount;
  agentId: string;
}): LifeOpsGoogleConnectorStatus {
  return googleStatusFromAccount({
    account: args.account,
    agentId: args.agentId,
    defaultMode: "local",
    availableModes: ["local"],
  });
}

function requireGoogleWorkspaceService(
  runtime: RuntimeWithService,
): IGoogleWorkspaceService {
  const service = runtime.getService("google");
  if (!service || typeof service !== "object") {
    fail(
      503,
      "Google Workspace service is not registered. Enable @elizaos/plugin-google before using calendar Google features.",
    );
  }
  return service as IGoogleWorkspaceService;
}

export function requireGoogleServiceMethod<
  K extends keyof IGoogleWorkspaceService,
>(runtime: RuntimeWithService, method: K): IGoogleWorkspaceService[K] {
  const service = requireGoogleWorkspaceService(runtime);
  const fn = service[method];
  if (typeof fn !== "function") {
    fail(
      501,
      `@elizaos/plugin-google does not expose ${String(method)} for account-scoped calendar access.`,
    );
  }
  return fn.bind(service) as IGoogleWorkspaceService[K];
}

export function accountIdForGrant(grant: LifeOpsConnectorGrant): string {
  return (
    stringValue(grant.connectorAccountId) ??
    googleAccountIdFromGrantId(grant.id) ??
    fail(
      409,
      "Google connector account id is missing. Reconnect Google through connector account management.",
    )
  );
}

function dateTimeValue(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

export function lifeOpsCalendarEventFromGoogle(args: {
  event: GoogleCalendarEvent;
  grant: LifeOpsConnectorGrant;
  agentId: string;
  syncedAt?: string;
}): LifeOpsCalendarEvent {
  const { event, grant, agentId } = args;
  const syncedAt = args.syncedAt ?? new Date().toISOString();
  const externalId = event.id;
  const startAt = dateTimeValue(event.start, syncedAt);
  const endAt = dateTimeValue(event.end, startAt);
  return {
    id: `${agentId}:google:${grant.side}:calendar:${event.calendarId}:${externalId}`,
    externalId,
    agentId,
    provider: "google",
    side: grant.side,
    calendarId: event.calendarId,
    title: event.title ?? "(untitled)",
    description: event.description ?? "",
    location: event.location ?? "",
    status: event.status ?? "confirmed",
    startAt,
    endAt,
    isAllDay: event.isAllDay ?? false,
    timezone: event.timeZone ?? null,
    htmlLink: event.htmlLink ?? null,
    conferenceLink: event.meetLink ?? null,
    organizer: event.organizer ? { ...event.organizer } : null,
    attendees: (event.attendees ?? []).map(lifeOpsCalendarAttendeeFromGoogle),
    recurrence: event.recurrence ?? null,
    recurringEventId: event.recurringEventId ?? null,
    metadata: {
      googlePlugin: true,
      ...(event.metadata ?? {}),
    },
    syncedAt,
    updatedAt: syncedAt,
    connectorAccountId: grant.connectorAccountId ?? undefined,
    grantId: grant.id,
    accountEmail: grant.identityEmail ?? undefined,
  };
}

function lifeOpsCalendarAttendeeFromGoogle(
  attendee: GoogleEmailAddress,
): LifeOpsCalendarEventAttendee {
  return {
    email: attendee.email,
    displayName: attendee.name ?? null,
    responseStatus: null,
    self: false,
    organizer: false,
    optional: false,
  };
}

export function lifeOpsCalendarSummaryFromGoogle(args: {
  entry: GoogleCalendarListEntry;
  grant: LifeOpsConnectorGrant;
  includeInFeed?: boolean;
}): LifeOpsCalendarSummary {
  const { entry, grant } = args;
  return {
    provider: "google",
    side: grant.side,
    grantId: grant.id,
    accountEmail: grant.identityEmail ?? null,
    calendarId: entry.calendarId,
    summary: entry.summary,
    description: entry.description,
    primary: entry.primary,
    accessRole: entry.accessRole,
    backgroundColor: entry.backgroundColor,
    foregroundColor: entry.foregroundColor,
    timeZone: entry.timeZone,
    selected: entry.selected,
    includeInFeed: args.includeInFeed ?? true,
  };
}

export function googleCalendarEventInput(args: {
  accountId: string;
  calendarId?: string | null;
  title: string;
  startAt: string;
  endAt: string;
  timeZone?: string | null;
  description?: string | null;
  location?: string | null;
  attendees?:
    | readonly { email?: string | null; displayName?: string | null }[]
    | null;
  recurrence?: readonly string[] | null;
}): GoogleCalendarEventInput {
  return {
    accountId: args.accountId,
    calendarId: args.calendarId ?? undefined,
    title: args.title,
    start: args.startAt,
    end: args.endAt,
    timeZone: args.timeZone ?? undefined,
    description: args.description ?? undefined,
    location: args.location ?? undefined,
    attendees: args.attendees
      ?.map((attendee) => attendee.email?.trim())
      .filter(Boolean)
      .map((email) => ({ email })) as GoogleEmailAddress[] | undefined,
    recurrence: args.recurrence ? [...args.recurrence] : undefined,
  };
}

export function googleCalendarEventPatchInput(args: {
  accountId: string;
  calendarId?: string | null;
  eventId: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string | null;
  description?: string;
  location?: string;
  attendees?:
    | readonly { email?: string | null; displayName?: string | null }[]
    | null;
  recurrence?: readonly string[] | null;
}): GoogleCalendarEventPatchInput {
  return {
    accountId: args.accountId,
    calendarId: args.calendarId ?? undefined,
    eventId: args.eventId,
    title: args.title,
    start: args.startAt,
    end: args.endAt,
    timeZone: args.timeZone ?? undefined,
    description: args.description,
    location: args.location,
    attendees: args.attendees
      ?.map((attendee) => attendee.email?.trim())
      .filter(Boolean)
      .map((email) => ({ email })) as GoogleEmailAddress[] | undefined,
    recurrence: args.recurrence ? [...args.recurrence] : undefined,
  };
}
