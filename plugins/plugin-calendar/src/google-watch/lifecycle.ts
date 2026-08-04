/**
 * Google Calendar push-channel orchestration on the shared ScheduledTask spine.
 *
 * Watch creation persists a provisional capability binding before the provider
 * call, because Google's initial `sync` notification may beat the watch
 * response. Webhooks authenticate headers, enqueue only a monotonic signal,
 * and refetch through the calendar service; provider payloads are never trusted.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  isBlockedHostname,
  isPrivateIpAddress,
} from "@elizaos/core";
import type { GoogleCalendarWatchResponse } from "@elizaos/plugin-google-workspace";
import {
  type DispatchResult,
  getScheduledTaskChannelDispatcher,
  getScheduledTaskRunner,
  registerScheduledTaskChannelDispatcher,
  type ScheduledTaskDispatchRecord,
} from "@elizaos/plugin-scheduling";
import type {
  LifeOpsCalendarChangeDeliveryHealth,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import { requireGoogleServiceMethod } from "../internal/google-delegates.js";
import {
  type GoogleCalendarWatchChannel,
  GoogleCalendarWatchRepository,
} from "./repository.js";

export const GOOGLE_CALENDAR_WEBHOOK_PATH =
  "/api/lifeops/calendar/google/webhook";
export const GOOGLE_CALENDAR_WATCH_TASK_CHANNEL =
  "calendar_google_watch_lifecycle";

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_RENEWAL_LEAD_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_WATCHES_PER_ACCOUNT = 32;
const DEFAULT_MAX_CONCURRENT_SYNCS_PER_ACCOUNT = 2;
const STALE_CREATION_MS = 10 * 60 * 1000;
const MAX_MESSAGE_NUMBER_DIGITS = 40;
const GOOGLE_RESOURCE_URI_HOST = "www.googleapis.com";
const GOOGLE_RESOURCE_URI_PATH_PREFIX = "/calendar/v3/";

type WatchStopFinalState = "stopped" | "revoked";

export interface GoogleCalendarWatchSource {
  grantId: string;
  connectorAccountId: string;
  side: LifeOpsConnectorSide;
  calendarId: string;
  calendarSummary: string;
  calendarAccessRole: string;
  timeZone: string;
  windowStartAt: string;
  windowEndAt: string;
}

export interface GoogleCalendarNotificationHeaders {
  channelId: string;
  channelToken: string;
  resourceId: string;
  resourceUri: string;
  resourceState: string;
  messageNumber: string;
}

export interface GoogleCalendarWebhookResult {
  status: 204 | 400 | 404 | 503;
  retryAfterSeconds?: number;
  outcome:
    | "processed"
    | "queued"
    | "duplicate"
    | "invalid"
    | "unauthorized"
    | "retry";
}

export interface GoogleCalendarWatchConfig {
  webhookUrl: string;
  ttlSeconds: number;
  renewalLeadMs: number;
  syncLeaseMs: number;
  maxWatchesPerAccount: number;
  maxConcurrentSyncsPerAccount: number;
}

export interface GoogleCalendarWatchLifecycleOptions {
  now?: () => Date;
  random?: () => number;
  config?: GoogleCalendarWatchConfig | null;
  syncChannel(channel: GoogleCalendarWatchChannel): Promise<void>;
}

type PendingSyncDrainResult =
  | { kind: "processed" }
  | { kind: "empty" }
  | { kind: "settled" }
  | { kind: "unauthorized" }
  | {
      kind: "busy";
      channel: GoogleCalendarWatchChannel;
      retryAtIso: string;
      retryAfterSeconds: number;
    }
  | {
      kind: "retry";
      channel: GoogleCalendarWatchChannel;
      retryAtIso: string;
      retryAfterSeconds: number;
      reason: Extract<DispatchResult, { ok: false }>["reason"];
      message: string;
    };

interface CalendarWatchScheduledTaskService {
  runGoogleCalendarWatchScheduledTask(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined>;
}

function isScheduledTaskService(
  value: unknown,
): value is CalendarWatchScheduledTaskService {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<CalendarWatchScheduledTaskService>)
      .runGoogleCalendarWatchScheduledTask === "function"
  );
}

function registerLifecycleTaskChannel(runtime: IAgentRuntime): void {
  if (
    getScheduledTaskChannelDispatcher(
      runtime,
      GOOGLE_CALENDAR_WATCH_TASK_CHANNEL,
    )
  ) {
    return;
  }
  registerScheduledTaskChannelDispatcher(runtime, {
    channelKey: GOOGLE_CALENDAR_WATCH_TASK_CHANNEL,
    async dispatch(record) {
      const service = runtime.getService("calendar");
      if (!isScheduledTaskService(service)) {
        return {
          ok: false,
          reason: "disconnected",
          userActionable: false,
          acceptance: "not_accepted",
          message: "Calendar watch lifecycle service is unavailable.",
        };
      }
      return service.runGoogleCalendarWatchScheduledTask(record);
    },
  });
}

function setting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isGoogleCalendarWebhookEnabled(
  runtime: IAgentRuntime | null,
): boolean {
  if (!runtime) return false;
  const value = runtime.getSetting?.("GOOGLE_CALENDAR_WEBHOOK_ENABLED");
  return (
    value === true ||
    (typeof value === "string" && value.trim().toLowerCase() === "true")
  );
}

function boundedIntegerSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = setting(runtime, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ElizaError(`${key} is outside its supported range.`, {
      code: "GOOGLE_CALENDAR_WATCH_INVALID_CONFIG",
      context: { key, minimum, maximum },
      severity: "fatal",
    });
  }
  return parsed;
}

function validateConfiguredWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    // error-policy:J2 Configuration parsing adds a stable domain code while
    // preserving URL's original parse failure as the cause.
    throw new ElizaError(
      "GOOGLE_CALENDAR_WEBHOOK_URL must be a valid HTTPS URL.",
      {
        code: "GOOGLE_CALENDAR_WATCH_INVALID_CONFIG",
        context: { key: "GOOGLE_CALENDAR_WEBHOOK_URL" },
        cause: error,
        severity: "fatal",
      },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== GOOGLE_CALENDAR_WEBHOOK_PATH ||
    isBlockedHostname(url.hostname) ||
    isPrivateIpAddress(url.hostname)
  ) {
    throw new ElizaError(
      `GOOGLE_CALENDAR_WEBHOOK_URL must be a public HTTPS origin with the exact path ${GOOGLE_CALENDAR_WEBHOOK_PATH}.`,
      {
        code: "GOOGLE_CALENDAR_WATCH_INVALID_CONFIG",
        context: { key: "GOOGLE_CALENDAR_WEBHOOK_URL" },
        severity: "fatal",
      },
    );
  }
  return url.toString();
}

function runtimeWatchConfig(
  runtime: IAgentRuntime,
): GoogleCalendarWatchConfig | null {
  if (!isGoogleCalendarWebhookEnabled(runtime)) return null;
  const webhookUrl = setting(runtime, "GOOGLE_CALENDAR_WEBHOOK_URL");
  if (!webhookUrl) return null;
  return {
    webhookUrl: validateConfiguredWebhookUrl(webhookUrl),
    ttlSeconds: boundedIntegerSetting(
      runtime,
      "GOOGLE_CALENDAR_WATCH_TTL_SECONDS",
      DEFAULT_TTL_SECONDS,
      60,
      DEFAULT_TTL_SECONDS,
    ),
    renewalLeadMs:
      boundedIntegerSetting(
        runtime,
        "GOOGLE_CALENDAR_WATCH_RENEWAL_LEAD_MINUTES",
        DEFAULT_RENEWAL_LEAD_MS / 60_000,
        5,
        3 * 24 * 60,
      ) * 60_000,
    syncLeaseMs:
      boundedIntegerSetting(
        runtime,
        "GOOGLE_CALENDAR_WATCH_SYNC_LEASE_SECONDS",
        DEFAULT_SYNC_LEASE_MS / 1000,
        30,
        30 * 60,
      ) * 1000,
    maxWatchesPerAccount: boundedIntegerSetting(
      runtime,
      "GOOGLE_CALENDAR_MAX_WATCHES_PER_ACCOUNT",
      DEFAULT_MAX_WATCHES_PER_ACCOUNT,
      1,
      256,
    ),
    maxConcurrentSyncsPerAccount: boundedIntegerSetting(
      runtime,
      "GOOGLE_CALENDAR_MAX_CONCURRENT_PUSH_SYNCS_PER_ACCOUNT",
      DEFAULT_MAX_CONCURRENT_SYNCS_PER_ACCOUNT,
      1,
      16,
    ),
  };
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenMatches(value: string, digest: string): boolean {
  const received = Buffer.from(tokenDigest(value), "hex");
  const expected = Buffer.from(digest, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function validMessageNumber(value: string): boolean {
  return new RegExp(`^[1-9][0-9]{0,${MAX_MESSAGE_NUMBER_DIGITS - 1}}$`).test(
    value,
  );
}

function validResourceUri(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === GOOGLE_RESOURCE_URI_HOST &&
      url.pathname.startsWith(GOOGLE_RESOURCE_URI_PATH_PREFIX) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    // error-policy:J3 Provider-controlled header text is explicitly invalid
    // when it is not a parseable Google resource URI.
    return false;
  }
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) {
    return Number(value);
  }
  return null;
}

function providerStatus(error: unknown): number | null {
  const record = errorRecord(error);
  const response = errorRecord(record?.response);
  return (
    numericStatus(response?.status) ??
    numericStatus(record?.status) ??
    numericStatus(record?.code)
  );
}

function providerReasons(error: unknown): string[] {
  const record = errorRecord(error);
  const response = errorRecord(record?.response);
  const data = errorRecord(response?.data);
  const apiError = errorRecord(data?.error);
  const candidates: unknown[] = [
    record?.reason,
    data?.reason,
    apiError?.reason,
    apiError?.status,
  ];
  for (const errors of [record?.errors, apiError?.errors]) {
    if (!Array.isArray(errors)) continue;
    for (const item of errors) {
      candidates.push(errorRecord(item)?.reason);
    }
  }
  return candidates
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function retryAfterSeconds(error: unknown): number | null {
  const response = errorRecord(errorRecord(error)?.response);
  const headers = response?.headers;
  let value: unknown;
  if (
    headers &&
    typeof headers === "object" &&
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    value = (headers as { get(name: string): unknown }).get("retry-after");
  } else {
    value = errorRecord(headers)?.["retry-after"];
  }
  const seconds =
    typeof value === "string" || typeof value === "number"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), 60 * 60)
    : null;
}

function elizaErrorCode(error: unknown): string | null {
  return error instanceof ElizaError ? error.code : null;
}

function classifyProviderFailure(
  error: unknown,
  operation: "watch" | "stop" | "sync",
): {
  code: string;
  message: string;
  retryable: boolean;
  reason: Extract<DispatchResult, { ok: false }>["reason"];
  retryAfterSeconds: number | null;
  absent: boolean;
  bindingMismatch: boolean;
} {
  const status = providerStatus(error);
  const code = elizaErrorCode(error);
  const reasons = providerReasons(error);
  const bindingMismatch = code === "GOOGLE_CALENDAR_WATCH_BINDING_MISMATCH";
  const absent = operation === "stop" && (status === 404 || status === 410);
  const rateLimited =
    status === 429 ||
    reasons.some(
      (reason) =>
        reason.includes("ratelimit") ||
        reason.includes("quota") ||
        reason === "resource_exhausted",
    );
  const authExpired = status === 401 || (status === 403 && !rateLimited);
  const retryable =
    !bindingMismatch &&
    !authExpired &&
    !absent &&
    (rateLimited ||
      status === 408 ||
      (status !== null && status >= 500) ||
      (error instanceof ElizaError && error.severity === "ephemeral") ||
      status === null);
  const reason = authExpired
    ? "auth_expired"
    : rateLimited
      ? "rate_limited"
      : "transport_error";
  return {
    code:
      code ??
      (authExpired
        ? "GOOGLE_CALENDAR_WATCH_AUTH_EXPIRED"
        : rateLimited
          ? "GOOGLE_CALENDAR_WATCH_RATE_LIMITED"
          : `GOOGLE_CALENDAR_CHANNEL_${operation.toUpperCase()}_FAILED`),
    message: bindingMismatch
      ? "Stored Google Calendar account binding no longer matches the connector grant."
      : authExpired
        ? "Google Calendar authorization expired."
        : rateLimited
          ? "Google Calendar channel quota is temporarily exhausted."
          : `Google Calendar ${operation} operation failed.`,
    retryable,
    reason,
    retryAfterSeconds: retryAfterSeconds(error),
    absent,
    bindingMismatch,
  };
}

function nextBackoff(args: {
  nowMs: number;
  failureCount: number;
  random: number;
  providerRetryAfterSeconds: number | null;
}): { seconds: number; atIso: string } {
  const exponential = Math.min(
    60 * 60,
    30 * 2 ** Math.min(args.failureCount, 7),
  );
  const jittered = Math.ceil(exponential + exponential * 0.5 * args.random);
  const seconds = Math.max(args.providerRetryAfterSeconds ?? 0, jittered);
  return {
    seconds,
    atIso: new Date(args.nowMs + seconds * 1000).toISOString(),
  };
}

function watchResponseMatchesRequest(
  response: GoogleCalendarWatchResponse,
  channelId: string,
  token: string,
): boolean {
  return (
    response.channelId === channelId &&
    (response.token === null || response.token === token) &&
    Boolean(response.resourceId) &&
    validResourceUri(response.resourceUri) &&
    Number.isFinite(Date.parse(response.expirationAt))
  );
}

export class GoogleCalendarWatchLifecycle {
  private readonly repo: GoogleCalendarWatchRepository;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly configuredOverride:
    | GoogleCalendarWatchConfig
    | null
    | undefined;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly options: GoogleCalendarWatchLifecycleOptions,
  ) {
    this.repo = new GoogleCalendarWatchRepository(runtime);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.configuredOverride = options.config;
    registerLifecycleTaskChannel(runtime);
  }

  private config(): GoogleCalendarWatchConfig | null {
    return this.configuredOverride === undefined
      ? runtimeWatchConfig(this.runtime)
      : this.configuredOverride;
  }

  async installMaintenanceTask(): Promise<void> {
    const runner = getScheduledTaskRunner(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const jitterMinutes = 45 + Math.floor(this.random() * 30);
    await runner.schedule({
      kind: "watcher",
      promptInstructions:
        "Maintain calendar background state, including Google push channels and durable cleanup effects.",
      trigger: {
        kind: "interval",
        everyMinutes: 60,
        from: new Date(
          this.now().getTime() + jitterMinutes * 60_000,
        ).toISOString(),
      },
      priority: "medium",
      escalation: {
        steps: [
          {
            delayMinutes: 0,
            channelKey: GOOGLE_CALENDAR_WATCH_TASK_CHANNEL,
          },
        ],
      },
      idempotencyKey: `calendar:google-watch:maintenance:${this.runtime.agentId}`,
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: "plugin-calendar",
      ownerVisible: false,
      metadata: { calendarGoogleWatchOperation: "maintenance" },
      executionProfile: "bg-light-30s",
    });
  }

  async ensureForSource(
    source: GoogleCalendarWatchSource,
  ): Promise<GoogleCalendarWatchChannel | null> {
    return this.createWatch(source);
  }

  private async createWatch(
    source: GoogleCalendarWatchSource,
    replacingChannelId?: string,
  ): Promise<GoogleCalendarWatchChannel | null> {
    const config = this.config();
    if (!config) return null;
    const now = this.now();
    const nowIso = now.toISOString();
    const current = await this.repo.findCurrentForBinding({
      agentId: this.runtime.agentId,
      grantId: source.grantId,
      connectorAccountId: source.connectorAccountId,
      calendarId: source.calendarId,
      nowIso,
    });
    if (current && current.channelId !== replacingChannelId) {
      return current;
    }
    const liveCount = await this.repo.countLiveForAccount(
      this.runtime.agentId,
      source.connectorAccountId,
      nowIso,
    );
    const limit = config.maxWatchesPerAccount + (replacingChannelId ? 1 : 0);
    if (liveCount >= limit) {
      throw new ElizaError(
        "Google Calendar watch resource budget is exhausted for this account.",
        {
          code: "GOOGLE_CALENDAR_WATCH_BUDGET_EXHAUSTED",
          context: {
            connectorAccountId: source.connectorAccountId,
            liveCount,
            limit,
          },
          severity: "ephemeral",
        },
      );
    }

    const channelId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const provisionalExpirationAt = new Date(
      now.getTime() + config.ttlSeconds * 1000,
    ).toISOString();
    await this.repo.createProvisional({
      ...source,
      channelId,
      agentId: this.runtime.agentId,
      webhookUrl: config.webhookUrl,
      tokenSha256: tokenDigest(token),
      provisionalExpirationAt,
      createdAt: nowIso,
    });

    try {
      const watchEvents = requireGoogleServiceMethod(
        this.runtime,
        "watchEvents",
      );
      const response = await watchEvents({
        accountId: source.connectorAccountId,
        calendarId: source.calendarId,
        channelId,
        address: config.webhookUrl,
        token,
        ttlSeconds: config.ttlSeconds,
      });
      if (!watchResponseMatchesRequest(response, channelId, token)) {
        throw new ElizaError(
          "Google Calendar watch response did not match the requested channel.",
          {
            code: "GOOGLE_CALENDAR_INVALID_WATCH_RESPONSE",
            context: {
              channelId,
              connectorAccountId: source.connectorAccountId,
              calendarId: source.calendarId,
            },
            severity: "fatal",
          },
        );
      }
      return await this.repo.finalizeCreated({
        agentId: this.runtime.agentId,
        channelId,
        resourceId: response.resourceId,
        resourceUri: response.resourceUri,
        expirationAt: response.expirationAt,
        updatedAt: this.now().toISOString(),
      });
    } catch (error) {
      // error-policy:J2 A failed provider watch keeps its durable provisional
      // row and adds typed lifecycle context before the caller handles it.
      const failure = classifyProviderFailure(error, "watch");
      const backoff = nextBackoff({
        nowMs: this.now().getTime(),
        failureCount: 0,
        random: this.random(),
        providerRetryAfterSeconds: failure.retryAfterSeconds,
      });
      await this.repo.markError({
        agentId: this.runtime.agentId,
        channelId,
        failedAt: this.now().toISOString(),
        error: failure,
        nextRetryAt: failure.retryable ? backoff.atIso : null,
      });
      throw new ElizaError(failure.message, {
        code: failure.code,
        context: {
          channelId,
          connectorAccountId: source.connectorAccountId,
          calendarId: source.calendarId,
          retryable: failure.retryable,
        },
        cause: error,
        severity: failure.retryable ? "ephemeral" : "fatal",
      });
    }
  }

  async handleNotification(
    headers: GoogleCalendarNotificationHeaders,
  ): Promise<GoogleCalendarWebhookResult> {
    if (
      !headers.channelId ||
      headers.channelId.length > 64 ||
      !headers.channelToken ||
      headers.channelToken.length > 256 ||
      !headers.resourceId ||
      headers.resourceId.length > 512 ||
      !validResourceUri(headers.resourceUri) ||
      !validMessageNumber(headers.messageNumber) ||
      !["sync", "exists", "not_exists"].includes(headers.resourceState) ||
      (headers.resourceState === "sync" && headers.messageNumber !== "1")
    ) {
      return { status: 400, outcome: "invalid" };
    }

    const config = this.config();
    if (!config) {
      return { status: 404, outcome: "unauthorized" };
    }
    const now = this.now();
    const nowIso = now.toISOString();
    let channel = await this.repo.get(this.runtime.agentId, headers.channelId);
    if (
      !channel ||
      !tokenMatches(headers.channelToken, channel.tokenSha256) ||
      !["creating", "active"].includes(channel.state) ||
      (channel.expirationAt !== null &&
        Date.parse(channel.expirationAt) <= now.getTime())
    ) {
      return { status: 404, outcome: "unauthorized" };
    }

    if (!channel.resourceId || !channel.resourceUri) {
      if (channel.state !== "creating" || headers.resourceState !== "sync") {
        return { status: 404, outcome: "unauthorized" };
      }
      channel = await this.repo.bindProvisionalResource({
        agentId: this.runtime.agentId,
        channelId: channel.channelId,
        resourceId: headers.resourceId,
        resourceUri: headers.resourceUri,
        updatedAt: nowIso,
      });
      if (!channel) {
        return { status: 404, outcome: "unauthorized" };
      }
    }
    if (
      channel.resourceId !== headers.resourceId ||
      channel.resourceUri !== headers.resourceUri
    ) {
      return { status: 404, outcome: "unauthorized" };
    }

    if (BigInt(headers.messageNumber) <= BigInt(channel.lastMessageNumber)) {
      return { status: 204, outcome: "duplicate" };
    }
    const enqueued = await this.repo.enqueueNotification({
      agentId: this.runtime.agentId,
      channelId: channel.channelId,
      messageNumber: headers.messageNumber,
      notifiedAt: nowIso,
    });
    if (!enqueued) {
      const current = await this.repo.get(
        this.runtime.agentId,
        channel.channelId,
      );
      return current &&
        BigInt(headers.messageNumber) <= BigInt(current.lastMessageNumber)
        ? { status: 204, outcome: "duplicate" }
        : { status: 404, outcome: "unauthorized" };
    }

    const result = await this.drainPendingChannel(channel.channelId, config);
    if (result.kind === "retry") {
      await this.scheduleSyncRetry(result.channel, result.retryAtIso);
      return {
        status: 503,
        outcome: "retry",
        retryAfterSeconds: result.retryAfterSeconds,
      };
    }
    if (result.kind === "busy") {
      await this.scheduleSyncRetry(result.channel, result.retryAtIso);
      return { status: 204, outcome: "queued" };
    }
    if (result.kind === "unauthorized") {
      return { status: 404, outcome: "unauthorized" };
    }
    return { status: 204, outcome: "processed" };
  }

  private async drainPendingChannel(
    channelId: string,
    config: GoogleCalendarWatchConfig,
  ): Promise<PendingSyncDrainResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseToken = randomUUID();
    let claimed = await this.repo.claimPendingSync({
      agentId: this.runtime.agentId,
      channelId,
      leaseToken,
      claimedAt: nowIso,
      leaseExpiresAt: new Date(
        now.getTime() + config.syncLeaseMs,
      ).toISOString(),
      maxConcurrentForAccount: config.maxConcurrentSyncsPerAccount,
    });
    if (!claimed) {
      const current = await this.repo.get(this.runtime.agentId, channelId);
      if (!current || !["creating", "active"].includes(current.state)) {
        return { kind: "settled" };
      }
      if (
        !current.pendingMessageNumber ||
        BigInt(current.pendingMessageNumber) <=
          BigInt(current.lastMessageNumber)
      ) {
        return { kind: "empty" };
      }
      if (
        current.nextRetryAt &&
        Date.parse(current.nextRetryAt) > now.getTime()
      ) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((Date.parse(current.nextRetryAt) - now.getTime()) / 1000),
        );
        return {
          kind: "retry",
          channel: current,
          retryAtIso: current.nextRetryAt,
          retryAfterSeconds,
          reason:
            current.error?.code === "GOOGLE_CALENDAR_WATCH_RATE_LIMITED"
              ? "rate_limited"
              : "transport_error",
          message: current.error
            ? current.error.message
            : "Google Calendar change refetch is waiting for its durable retry.",
        };
      }
      const leaseExpiresAtMs = current.syncLeaseExpiresAt
        ? Date.parse(current.syncLeaseExpiresAt)
        : Number.NaN;
      const retryAfterSeconds = Number.isFinite(leaseExpiresAtMs)
        ? Math.max(1, Math.ceil((leaseExpiresAtMs - now.getTime()) / 1000))
        : 60;
      return {
        kind: "busy",
        channel: current,
        retryAtIso: new Date(
          now.getTime() + retryAfterSeconds * 1000,
        ).toISOString(),
        retryAfterSeconds,
      };
    }

    while (claimed.pendingMessageNumber) {
      const targetMessageNumber = claimed.pendingMessageNumber;
      try {
        await this.options.syncChannel(claimed);
      } catch (error) {
        // error-policy:J1 The public webhook boundary records a retryable
        // failure without advancing the durable message cursor.
        const failure = classifyProviderFailure(error, "sync");
        const backoff = nextBackoff({
          nowMs: this.now().getTime(),
          failureCount: claimed.failureCount,
          random: this.random(),
          providerRetryAfterSeconds: failure.retryAfterSeconds,
        });
        if (failure.bindingMismatch) {
          await this.repo.markError({
            agentId: this.runtime.agentId,
            channelId: claimed.channelId,
            failedAt: this.now().toISOString(),
            state: "revoked",
            error: failure,
          });
          return { kind: "unauthorized" };
        }
        if (!failure.retryable) {
          await this.repo.markError({
            agentId: this.runtime.agentId,
            channelId: claimed.channelId,
            failedAt: this.now().toISOString(),
            state: failure.reason === "auth_expired" ? "revoked" : "error",
            error: failure,
          });
          return { kind: "settled" };
        }
        const released = await this.repo.releaseFailedSync({
          agentId: this.runtime.agentId,
          channelId: claimed.channelId,
          leaseToken,
          failedAt: this.now().toISOString(),
          error: failure,
          nextRetryAt: backoff.atIso,
        });
        return {
          kind: "retry",
          channel: released,
          retryAtIso: backoff.atIso,
          retryAfterSeconds: backoff.seconds,
          reason: failure.reason,
          message: failure.message,
        };
      }
      claimed = await this.repo.completePendingSync({
        agentId: this.runtime.agentId,
        channelId: claimed.channelId,
        leaseToken,
        processedMessageNumber: targetMessageNumber,
        completedAt: this.now().toISOString(),
      });
      if (!claimed.pendingMessageNumber) {
        return { kind: "processed" };
      }
    }
    return { kind: "processed" };
  }

  async sourceHealth(
    source: Pick<
      GoogleCalendarWatchSource,
      "grantId" | "connectorAccountId" | "calendarId"
    >,
  ): Promise<LifeOpsCalendarChangeDeliveryHealth> {
    if (!this.config()) {
      return {
        mode: "polling",
        status: "unconfigured",
        expiresAt: null,
        lastNotificationAt: null,
        lastSuccessfulSyncAt: null,
        error: null,
      };
    }
    const channel = await this.repo.findHealthForBinding({
      agentId: this.runtime.agentId,
      ...source,
    });
    if (!channel) {
      return {
        mode: "push",
        status: "starting",
        expiresAt: null,
        lastNotificationAt: null,
        lastSuccessfulSyncAt: null,
        error: null,
      };
    }
    const expired =
      channel.expirationAt !== null &&
      Date.parse(channel.expirationAt) <= this.now().getTime();
    const status =
      channel.state === "revoked"
        ? "revoked"
        : expired || channel.state === "expired"
          ? "expired"
          : channel.state === "active"
            ? "active"
            : channel.state === "creating"
              ? "starting"
              : "degraded";
    return {
      mode: "push",
      status,
      expiresAt: channel.expirationAt,
      lastNotificationAt: channel.lastNotificationAt,
      lastSuccessfulSyncAt: channel.lastSyncAt,
      error: channel.error,
    };
  }

  async runScheduledTask(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined> {
    const operation = record.metadata?.calendarGoogleWatchOperation;
    if (operation === "maintenance") {
      return this.runMaintenance();
    }
    if (operation === "sync-retry") {
      const channelId = record.metadata?.channelId;
      if (typeof channelId !== "string") {
        throw new ElizaError(
          "Calendar watch sync retry task metadata is invalid.",
          {
            code: "GOOGLE_CALENDAR_WATCH_INVALID_TASK",
            context: { taskId: record.taskId },
            severity: "fatal",
          },
        );
      }
      const config = this.config();
      if (!config) {
        return {
          ok: true,
          messageId: `calendar-watch:sync-retry-unconfigured:${channelId}`,
        };
      }
      const result = await this.drainPendingChannel(channelId, config);
      if (
        result.kind === "processed" ||
        result.kind === "empty" ||
        result.kind === "settled" ||
        result.kind === "unauthorized"
      ) {
        return {
          ok: true,
          messageId: `calendar-watch:sync-retry:${channelId}:${result.kind}`,
        };
      }
      return {
        ok: false,
        reason: result.kind === "retry" ? result.reason : "transport_error",
        retryAfterMinutes: Math.max(
          1,
          Math.ceil(result.retryAfterSeconds / 60),
        ),
        userActionable: false,
        acceptance: "not_accepted",
        message:
          result.kind === "retry"
            ? result.message
            : "Google Calendar change refetch is already in progress.",
      };
    }
    if (operation === "stop") {
      const channelId = record.metadata?.channelId;
      const finalState = record.metadata?.finalState;
      if (
        typeof channelId !== "string" ||
        (finalState !== "stopped" && finalState !== "revoked")
      ) {
        throw new ElizaError("Calendar watch stop task metadata is invalid.", {
          code: "GOOGLE_CALENDAR_WATCH_INVALID_TASK",
          context: { taskId: record.taskId },
          severity: "fatal",
        });
      }
      return this.stopChannel(channelId, finalState);
    }
    throw new ElizaError(
      "Calendar watch scheduled task operation is unknown.",
      {
        code: "GOOGLE_CALENDAR_WATCH_INVALID_TASK",
        context: { taskId: record.taskId },
        severity: "fatal",
      },
    );
  }

  private async runMaintenance(): Promise<DispatchResult> {
    const config = this.config();
    if (!config) {
      const channels = await this.repo.listForMaintenance(this.runtime.agentId);
      for (const channel of channels) {
        const result = await this.scheduleStop(channel, "stopped", true);
        if (result?.ok === false) return result;
      }
      return {
        ok: true,
        messageId: `calendar-watch:unconfigured:${channels.length}`,
      };
    }
    const now = this.now();
    const channels = await this.repo.listForMaintenance(this.runtime.agentId);
    let retry: Extract<DispatchResult, { ok: false }> | null = null;
    for (const channel of channels) {
      try {
        if (channel.state === "stopping") {
          const result = await this.scheduleStop(channel, "stopped", true);
          if (result && result.ok === false) retry = result;
          continue;
        }
        const expirationMs = channel.expirationAt
          ? Date.parse(channel.expirationAt)
          : Number.NaN;
        if (
          channel.state === "creating" &&
          now.getTime() - Date.parse(channel.createdAt) > STALE_CREATION_MS
        ) {
          await this.repo.markError({
            agentId: this.runtime.agentId,
            channelId: channel.channelId,
            failedAt: now.toISOString(),
            error: {
              code: "GOOGLE_CALENDAR_WATCH_CREATION_TIMED_OUT",
              message:
                "Google Calendar watch creation did not return before its safety window.",
              retryable: true,
            },
            nextRetryAt: now.toISOString(),
          });
          if (channel.resourceId) {
            const result = await this.scheduleStop(channel, "stopped", true);
            if (result && result.ok === false) retry = result;
            if (!result || result.ok) {
              await this.createWatch(channel);
            }
          } else {
            await this.createWatch(channel);
          }
          continue;
        }
        if (
          channel.state === "active" &&
          Number.isFinite(expirationMs) &&
          expirationMs <= now.getTime()
        ) {
          await this.repo.markStopped({
            agentId: this.runtime.agentId,
            channelId: channel.channelId,
            state: "expired",
            updatedAt: now.toISOString(),
          });
          await this.createWatch(channel);
          continue;
        }
        if (
          (channel.state === "creating" || channel.state === "active") &&
          channel.pendingMessageNumber &&
          (!channel.nextRetryAt ||
            Date.parse(channel.nextRetryAt) <= now.getTime()) &&
          (!channel.syncLeaseExpiresAt ||
            Date.parse(channel.syncLeaseExpiresAt) <= now.getTime())
        ) {
          await this.scheduleSyncRetry(
            channel,
            channel.nextRetryAt ? channel.nextRetryAt : now.toISOString(),
          );
        }
        if (
          channel.state === "active" &&
          !channel.renewalChannelId &&
          Number.isFinite(expirationMs) &&
          expirationMs <= now.getTime() + config.renewalLeadMs
        ) {
          const replacement = await this.createWatch(
            channel,
            channel.channelId,
          );
          if (replacement && replacement.channelId !== channel.channelId) {
            await this.repo.markRenewed({
              agentId: this.runtime.agentId,
              channelId: channel.channelId,
              renewalChannelId: replacement.channelId,
              updatedAt: this.now().toISOString(),
            });
            const result = await this.scheduleStop(channel, "stopped", true);
            if (result && result.ok === false) retry = result;
          }
          continue;
        }
        if (
          channel.state === "error" &&
          channel.error?.retryable &&
          (!channel.nextRetryAt ||
            Date.parse(channel.nextRetryAt) <= now.getTime())
        ) {
          if (channel.resourceId) {
            const result = await this.scheduleStop(channel, "stopped", true);
            if (result && result.ok === false) retry = result;
            if (!result || result.ok) {
              await this.createWatch(channel);
            }
          } else {
            await this.createWatch(channel);
          }
        }
      } catch (error) {
        // error-policy:J7 One channel must not prevent maintenance of the
        // remaining channels; the runner receives a typed retry afterward.
        this.runtime.reportError("calendar:google-watch-maintenance", error, {
          channelId: channel.channelId,
        });
        const failure = classifyProviderFailure(error, "watch");
        retry = {
          ok: false,
          reason: failure.reason,
          retryAfterMinutes: Math.ceil((failure.retryAfterSeconds ?? 60) / 60),
          userActionable: failure.reason === "auth_expired",
          acceptance: "not_accepted",
          message: failure.message,
        };
      }
    }
    return (
      retry ?? {
        ok: true,
        messageId: `calendar-watch:maintained:${channels.length}`,
      }
    );
  }

  private async scheduleSyncRetry(
    channel: GoogleCalendarWatchChannel,
    atIso: string,
  ): Promise<void> {
    if (!channel.pendingMessageNumber) return;
    const runner = getScheduledTaskRunner(this.runtime, {
      agentId: this.runtime.agentId,
    });
    await runner.schedule({
      kind: "custom",
      promptInstructions:
        "Refetch Google Calendar changes for a pending push notification.",
      trigger: { kind: "once", atIso },
      priority: "medium",
      escalation: {
        steps: [
          {
            delayMinutes: 0,
            channelKey: GOOGLE_CALENDAR_WATCH_TASK_CHANNEL,
          },
        ],
      },
      idempotencyKey:
        `calendar:google-watch:sync-retry:${channel.channelId}:` +
        `${channel.pendingMessageNumber}:${channel.failureCount}`,
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: "plugin-calendar",
      ownerVisible: false,
      metadata: {
        calendarGoogleWatchOperation: "sync-retry",
        channelId: channel.channelId,
      },
      executionProfile: "bg-light-30s",
    });
  }

  private async scheduleStop(
    channel: GoogleCalendarWatchChannel,
    finalState: WatchStopFinalState,
    fireNow: boolean,
  ): Promise<DispatchResult | undefined> {
    await this.repo.markStopping(
      this.runtime.agentId,
      channel.channelId,
      this.now().toISOString(),
    );
    const runner = getScheduledTaskRunner(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const task = await runner.schedule({
      kind: "custom",
      promptInstructions: "Stop a retired Google Calendar push channel.",
      trigger: { kind: "manual" },
      priority: "medium",
      escalation: {
        steps: [
          {
            delayMinutes: 0,
            channelKey: GOOGLE_CALENDAR_WATCH_TASK_CHANNEL,
          },
        ],
      },
      idempotencyKey: `calendar:google-watch:stop:${channel.channelId}:${channel.failureCount}`,
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: "plugin-calendar",
      ownerVisible: false,
      metadata: {
        calendarGoogleWatchOperation: "stop",
        channelId: channel.channelId,
        finalState,
      },
      executionProfile: "bg-light-30s",
    });
    if (!fireNow) return undefined;
    const result = await runner.fireWithResult(task.taskId);
    if (result.kind === "dispatch_deferred") {
      return {
        ok: false,
        reason: "transport_error",
        retryAfterMinutes: Math.max(
          1,
          Math.ceil(
            (Date.parse(result.nextAttemptAtIso) - this.now().getTime()) /
              60_000,
          ),
        ),
        userActionable: false,
        acceptance: "not_accepted",
        message: result.reason,
      };
    }
    if (result.kind === "dispatch_failed") {
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        acceptance: "not_accepted",
        message: result.error.message,
      };
    }
    return { ok: true, messageId: `calendar-watch:stop:${channel.channelId}` };
  }

  private async stopChannel(
    channelId: string,
    finalState: WatchStopFinalState,
  ): Promise<DispatchResult> {
    const channel = await this.repo.get(this.runtime.agentId, channelId);
    if (!channel || ["stopped", "revoked", "expired"].includes(channel.state)) {
      return { ok: true, messageId: `calendar-watch:already-${finalState}` };
    }
    if (!channel.resourceId) {
      await this.repo.markStopped({
        agentId: this.runtime.agentId,
        channelId,
        state: finalState,
        updatedAt: this.now().toISOString(),
      });
      return {
        ok: true,
        messageId: `calendar-watch:${finalState}:${channelId}`,
      };
    }
    try {
      const stopChannel = requireGoogleServiceMethod(
        this.runtime,
        "stopCalendarChannel",
      );
      await stopChannel({
        accountId: channel.connectorAccountId,
        channelId,
        resourceId: channel.resourceId,
      });
      await this.repo.markStopped({
        agentId: this.runtime.agentId,
        channelId,
        state: finalState,
        updatedAt: this.now().toISOString(),
      });
      return {
        ok: true,
        messageId: `calendar-watch:${finalState}:${channelId}`,
      };
    } catch (error) {
      // error-policy:J1 Provider stop failures become the runner's typed
      // retry/auth taxonomy; a 404/410 proves the channel is already absent.
      const failure = classifyProviderFailure(error, "stop");
      if (failure.absent || failure.reason === "auth_expired") {
        await this.repo.markStopped({
          agentId: this.runtime.agentId,
          channelId,
          state: failure.reason === "auth_expired" ? "revoked" : finalState,
          updatedAt: this.now().toISOString(),
        });
        return { ok: true, messageId: `calendar-watch:absent:${channelId}` };
      }
      const backoff = nextBackoff({
        nowMs: this.now().getTime(),
        failureCount: channel.failureCount,
        random: this.random(),
        providerRetryAfterSeconds: failure.retryAfterSeconds,
      });
      await this.repo.markError({
        agentId: this.runtime.agentId,
        channelId,
        failedAt: this.now().toISOString(),
        error: failure,
        nextRetryAt: failure.retryable ? backoff.atIso : null,
      });
      return {
        ok: false,
        reason: failure.reason,
        retryAfterMinutes: Math.ceil(backoff.seconds / 60),
        userActionable: false,
        acceptance: "not_accepted",
        message: failure.message,
      };
    }
  }

  async revokeAccount(connectorAccountId: string): Promise<void> {
    const channels = await this.repo.listForAccount(
      this.runtime.agentId,
      connectorAccountId,
    );
    for (const channel of channels) {
      const result = await this.scheduleStop(channel, "revoked", true);
      if (result?.ok === false) {
        throw new ElizaError(
          "Google Calendar push channels could not be revoked before account deletion.",
          {
            code: "GOOGLE_CALENDAR_WATCH_REVOCATION_DEFERRED",
            context: {
              connectorAccountId,
              channelId: channel.channelId,
              reason: result.reason,
            },
            severity: "ephemeral",
          },
        );
      }
    }
  }
}
