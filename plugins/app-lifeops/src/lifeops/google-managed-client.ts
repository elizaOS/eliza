import { resolveCloudApiKey } from "@elizaos/agent/cloud/cloud-api-key";
import {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "@elizaos/agent/cloud/base-url";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorReason,
  SendLifeOpsGmailMessageRequest,
  StartLifeOpsGoogleConnectorResponse,
} from "../contracts/index.js";
import type { GmailSubscriptionMessageHeaders } from "./email-unsubscribe-gmail.js";
import type { SyncedGoogleCalendarEvent } from "./google-calendar.js";
import type { SyncedGoogleGmailMessageSummary } from "./google-gmail.js";
import { formatInstantAsRfc3339InTimeZone } from "./time.js";

const MANAGED_GOOGLE_REQUEST_TIMEOUT_MS = 20_000;

export class ManagedGoogleClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ManagedGoogleClientError";
  }
}

export interface ResolvedManagedGoogleCloudConfig {
  configured: boolean;
  apiKey: string | null;
  apiBaseUrl: string;
  siteUrl: string;
}

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

type ManagedCloudRuntimeLike = {
  getService?: (serviceType: string) => unknown;
  getSetting?: (key: string) => unknown;
  character?: {
    secrets?: Record<string, unknown>;
  } | null;
} | null;

export interface ManagedGoogleConnectorStatusResponse {
  provider: "google";
  side: LifeOpsConnectorSide;
  mode: "cloud_managed";
  configured: boolean;
  connected: boolean;
  reason: LifeOpsGoogleConnectorReason;
  identity: Record<string, unknown> | null;
  grantedCapabilities: LifeOpsGoogleCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectionId: string | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
}

export interface ManagedGoogleCalendarFeedResponse {
  calendarId: string;
  events: SyncedGoogleCalendarEvent[];
  syncedAt: string;
}

export interface ManagedGoogleCalendarSummaryResponse {
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

export interface ManagedGoogleCalendarEventResponse {
  event: SyncedGoogleCalendarEvent;
}

export interface ManagedGoogleCalendarEventUpdateRequest {
  side: LifeOpsConnectorSide;
  grantId?: string;
  calendarId?: string | null;
  eventId: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
}

export interface ManagedGoogleGmailTriageResponse {
  messages: SyncedGoogleGmailMessageSummary[];
  syncedAt: string;
}

export interface ManagedGoogleGmailSearchResponse {
  messages: SyncedGoogleGmailMessageSummary[];
  syncedAt: string;
}

export interface ManagedGoogleGmailReadResponse {
  message: SyncedGoogleGmailMessageSummary;
  bodyText: string;
}

export interface ManagedGoogleGmailSubscriptionHeadersResponse {
  headers: GmailSubscriptionMessageHeaders[];
  syncedAt: string;
}

export interface ManagedGoogleReplySendRequest {
  side?: LifeOpsConnectorSide;
  grantId?: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface ManagedGoogleMessageSendRequest
  extends Omit<SendLifeOpsGmailMessageRequest, "mode" | "confirmSend"> {
  side?: LifeOpsConnectorSide;
  grantId?: string;
}

interface GenericOAuthInitiateResponse {
  authUrl: string;
  state?: string;
  provider?: {
    id?: string;
    name?: string;
  };
}

const DEFAULT_MANAGED_GOOGLE_CAPABILITIES: readonly LifeOpsGoogleCapability[] =
  [
    "google.basic_identity",
    "google.calendar.read",
    "google.gmail.triage",
    "google.gmail.send",
  ] as const;

function normalizeManagedGoogleCapabilities(
  capabilities?: readonly LifeOpsGoogleCapability[],
): LifeOpsGoogleCapability[] {
  const source = capabilities ?? DEFAULT_MANAGED_GOOGLE_CAPABILITIES;
  const normalized = [...new Set(source)];
  return normalized.includes("google.basic_identity")
    ? normalized
    : ["google.basic_identity", ...normalized];
}

function hasExplicitDateTimeOffset(value: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value);
}

function normalizeManagedCalendarDateTime(
  dateTime: string,
  timeZone: string | undefined,
): string {
  if (!timeZone || !hasExplicitDateTimeOffset(dateTime)) {
    return dateTime;
  }
  return formatInstantAsRfc3339InTimeZone(dateTime, timeZone);
}

function managedGoogleCapabilitiesToScopes(
  capabilities: readonly LifeOpsGoogleCapability[],
): string[] {
  const scopes = new Set<string>([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);

  for (const capability of normalizeManagedGoogleCapabilities(capabilities)) {
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

function normalizeApiKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) {
    return null;
  }
  return trimmed.toUpperCase() === "[REDACTED]" ? null : trimmed;
}

function loadManagedCloudSettings(): {
  config: Record<string, unknown>;
  baseUrl: string | null;
} {
  try {
    const config = loadElizaConfig();
    const cloud =
      config.cloud && typeof config.cloud === "object"
        ? (config.cloud as Record<string, unknown>)
        : null;
    return {
      config,
      baseUrl:
        cloud &&
        typeof cloud.baseUrl === "string" &&
        cloud.baseUrl.trim().length
          ? cloud.baseUrl.trim()
          : null,
    };
  } catch {
    return {
      config: {},
      baseUrl: null,
    };
  }
}

function resolveRuntimeCloudApiKey(
  runtime?: ManagedCloudRuntimeLike,
): string | null {
  const cloudAuth = runtime?.getService?.("CLOUD_AUTH");
  if (!cloudAuth || typeof cloudAuth !== "object") {
    return null;
  }
  const service = cloudAuth as CloudAuthApiKeyService;
  if (service.isAuthenticated?.() !== true) {
    return null;
  }
  return normalizeApiKey(service.getApiKey?.());
}

function buildTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    const text = await response.text();
    const trimmed = text.trim();
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (trimmed.length > 0) {
      try {
        if (contentType.includes("text/html") && !/^[{[]/.test(trimmed)) {
          throw new Error("html response");
        }
        const parsed = JSON.parse(trimmed) as {
          error?: string;
          message?: string;
        };
        detail = parsed.message ?? parsed.error ?? trimmed;
      } catch {
        if (!contentType.includes("text/html")) {
          detail = trimmed.slice(0, 200);
        }
      }
    }
    throw new ManagedGoogleClientError(response.status, detail);
  }

  return (await response.json()) as T;
}

export function resolveManagedGoogleCloudConfig(
  runtime?: ManagedCloudRuntimeLike,
): ResolvedManagedGoogleCloudConfig {
  const cloudSettings = loadManagedCloudSettings();
  const apiKey =
    resolveRuntimeCloudApiKey(runtime) ??
    normalizeApiKey(resolveCloudApiKey(cloudSettings.config, runtime));
  const baseUrl = cloudSettings.baseUrl ?? process.env.ELIZAOS_CLOUD_BASE_URL;
  const siteUrl = normalizeCloudSiteUrl(baseUrl);
  const apiBaseUrl = resolveCloudApiBaseUrl(baseUrl);

  return {
    configured: Boolean(apiKey),
    apiKey,
    apiBaseUrl,
    siteUrl,
  };
}

export class GoogleManagedClient {
  constructor(
    private readonly configSource:
      | ResolvedManagedGoogleCloudConfig
      | (() => ResolvedManagedGoogleCloudConfig) = resolveManagedGoogleCloudConfig,
  ) {}

  private getConfig(): ResolvedManagedGoogleCloudConfig {
    return typeof this.configSource === "function"
      ? this.configSource()
      : this.configSource;
  }

  get configured(): boolean {
    return this.getConfig().configured;
  }

  private requireConfig(): ResolvedManagedGoogleCloudConfig & {
    apiKey: string;
  } {
    const config = this.getConfig();
    if (!config.apiKey) {
      throw new ManagedGoogleClientError(409, "Eliza Cloud is not connected.");
    }
    return {
      ...config,
      apiKey: config.apiKey,
    };
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const config = this.requireConfig();
    const url = new URL(
      pathname.replace(/^\/+/, ""),
      `${config.apiBaseUrl.replace(/\/+$/, "")}/`,
    );
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
        ...(init.headers ?? {}),
      },
      signal:
        init.signal ?? buildTimeoutSignal(MANAGED_GOOGLE_REQUEST_TIMEOUT_MS),
    });
    return readJsonResponse<T>(response);
  }

  async getStatus(
    side: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<ManagedGoogleConnectorStatusResponse> {
    const query = new URLSearchParams({ side });
    if (grantId) query.set("grantId", grantId);
    return this.request<ManagedGoogleConnectorStatusResponse>(
      `eliza/google/status?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async listAccounts(
    side?: LifeOpsConnectorSide,
  ): Promise<ManagedGoogleConnectorStatusResponse[]> {
    const query = new URLSearchParams();
    if (side) query.set("side", side);
    return this.request<ManagedGoogleConnectorStatusResponse[]>(
      `eliza/google/accounts?${query.toString()}`,
      { method: "GET" },
    );
  }

  async startConnector(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    capabilities?: LifeOpsGoogleCapability[];
    redirectUrl?: string;
  }): Promise<StartLifeOpsGoogleConnectorResponse> {
    const redirectUri =
      args.redirectUrl ??
      new URL(
        "/auth/success?platform=google",
        `${this.requireConfig().siteUrl.replace(/\/+$/, "")}/`,
      ).toString();
    const requestedCapabilities = normalizeManagedGoogleCapabilities(
      args.capabilities,
    );
    const auth = await this.request<GenericOAuthInitiateResponse>(
      "oauth/google/initiate",
      {
        method: "POST",
        body: JSON.stringify({
          redirectUrl: redirectUri,
          scopes: managedGoogleCapabilitiesToScopes(requestedCapabilities),
          connectionRole: args.side,
          ...(args.grantId ? { grantId: args.grantId } : {}),
        }),
      },
    );
    return {
      provider: "google",
      side: args.side,
      mode: "cloud_managed",
      requestedCapabilities,
      redirectUri,
      authUrl: auth.authUrl,
    };
  }

  async disconnectConnector(
    connectionId?: string | null,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.request<{ ok: true }>("eliza/google/disconnect", {
      method: "POST",
      body: JSON.stringify({
        connectionId: connectionId ?? null,
        side: side ?? "owner",
      }),
    });
  }

  async getCalendarFeed(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<ManagedGoogleCalendarFeedResponse> {
    const query = new URLSearchParams({
      side: args.side,
      calendarId: args.calendarId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      timeZone: args.timeZone,
    });
    if (args.grantId) query.set("grantId", args.grantId);
    return this.request<ManagedGoogleCalendarFeedResponse>(
      `eliza/google/calendar/feed?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async listCalendars(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
  }): Promise<ManagedGoogleCalendarSummaryResponse[]> {
    const query = new URLSearchParams({
      side: args.side,
    });
    if (args.grantId) query.set("grantId", args.grantId);
    return this.request<ManagedGoogleCalendarSummaryResponse[]>(
      `eliza/google/calendar/calendars?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async createCalendarEvent(
    request: Omit<CreateLifeOpsCalendarEventRequest, "mode"> & {
      side: LifeOpsConnectorSide;
      grantId?: string;
    },
  ): Promise<ManagedGoogleCalendarEventResponse> {
    const normalizedRequest = {
      ...request,
      startAt: normalizeManagedCalendarDateTime(
        request.startAt ?? "",
        request.timeZone,
      ),
      endAt: normalizeManagedCalendarDateTime(
        request.endAt ?? "",
        request.timeZone,
      ),
    };
    return this.request<ManagedGoogleCalendarEventResponse>(
      "eliza/google/calendar/events",
      {
        method: "POST",
        body: JSON.stringify(normalizedRequest),
      },
    );
  }

  async updateCalendarEvent(
    request: ManagedGoogleCalendarEventUpdateRequest,
  ): Promise<ManagedGoogleCalendarEventResponse> {
    const normalizedRequest = {
      side: request.side,
      ...(request.grantId ? { grantId: request.grantId } : {}),
      calendarId: request.calendarId ?? undefined,
      title: request.title,
      description: request.description,
      location: request.location,
      startAt:
        typeof request.startAt === "string"
          ? normalizeManagedCalendarDateTime(request.startAt, request.timeZone)
          : undefined,
      endAt:
        typeof request.endAt === "string"
          ? normalizeManagedCalendarDateTime(request.endAt, request.timeZone)
          : undefined,
      timeZone: request.timeZone,
      attendees: request.attendees ?? undefined,
    };
    return this.request<ManagedGoogleCalendarEventResponse>(
      `eliza/google/calendar/events/${encodeURIComponent(request.eventId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(normalizedRequest),
      },
    );
  }

  async deleteCalendarEvent(request: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    calendarId?: string | null;
    eventId: string;
  }): Promise<{ ok: true }> {
    const query = new URLSearchParams({
      side: request.side,
      ...(request.calendarId ? { calendarId: request.calendarId } : {}),
    });
    if (request.grantId) query.set("grantId", request.grantId);
    return this.request<{ ok: true }>(
      `eliza/google/calendar/events/${encodeURIComponent(request.eventId)}?${query.toString()}`,
      {
        method: "DELETE",
      },
    );
  }

  async getGmailTriage(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    maxResults: number;
  }): Promise<ManagedGoogleGmailTriageResponse> {
    const query = new URLSearchParams({
      side: args.side,
      maxResults: String(args.maxResults),
    });
    if (args.grantId) query.set("grantId", args.grantId);
    return this.request<ManagedGoogleGmailTriageResponse>(
      `eliza/google/gmail/triage?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async getGmailSearch(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    query: string;
    maxResults: number;
  }): Promise<ManagedGoogleGmailSearchResponse> {
    const query = new URLSearchParams({
      side: args.side,
      query: args.query,
      maxResults: String(args.maxResults),
    });
    if (args.grantId) query.set("grantId", args.grantId);
    return this.request<ManagedGoogleGmailSearchResponse>(
      `eliza/google/gmail/search?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async getGmailSubscriptionHeaders(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    query: string;
    maxResults: number;
  }): Promise<ManagedGoogleGmailSubscriptionHeadersResponse> {
    const query = new URLSearchParams({
      side: args.side,
      query: args.query,
      maxResults: String(args.maxResults),
    });
    if (args.grantId) query.set("grantId", args.grantId);
    return this.request<ManagedGoogleGmailSubscriptionHeadersResponse>(
      `eliza/google/gmail/subscription-headers?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async readGmailMessage(args: {
    side: LifeOpsConnectorSide;
    grantId?: string;
    messageId: string;
  }): Promise<ManagedGoogleGmailReadResponse> {
    const query = new URLSearchParams({
      side: args.side,
      messageId: args.messageId,
    });
    if (args.grantId) query.set("grantId", args.grantId);
    return this.request<ManagedGoogleGmailReadResponse>(
      `eliza/google/gmail/read?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async sendGmailReply(
    request: ManagedGoogleReplySendRequest,
  ): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("eliza/google/gmail/reply-send", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async sendGmailMessage(
    request: ManagedGoogleMessageSendRequest,
  ): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("eliza/google/gmail/message-send", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }
}
