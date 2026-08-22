/**
 * CONNECTOR action — owner-facing facade for personal-assistant connector
 * status and control (list, status, enable/disable, mode and side selection).
 * Verification is read-only: external test messages must use the ordinary
 * draft and owner-approval path so a diagnostic can never bypass send policy.
 * The actual connector clients live in their own plugins; this action only
 * projects and toggles their normalized status through the ConnectorRegistry.
 */
import { extractActionParamsViaLlm } from "@elizaos/agent";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  MessageConnector,
  State,
} from "@elizaos/core";
import type { LifeOpsGoogleCapability } from "../contracts/index.js";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops/access.js";
import { getConnectorRegistry } from "../lifeops/connectors/index.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { darwinUnavailableActionResult, isDarwin } from "../platform/host.js";

const ACTION_NAME = "CONNECTOR";

/**
 * Connector kinds the action's verbose dispatcher table understands.
 *
 * These values are kept narrow so the verbose-result dispatchers (with rich
 * provider-specific verify probes) keep their typed surface; any connector
 * registered via `ConnectorRegistry` but not present here resolves through
 * the generic registry-backed fallback dispatcher.
 */
const VERBOSE_DISPATCHER_KINDS = [
  "google",
  "x",
  "telegram",
  "signal",
  "discord",
  "imessage",
  "whatsapp",
  "wechat",
  "health",
  "browser_bridge",
] as const;

const VALID_SUBACTIONS = [
  "connect",
  "disconnect",
  "verify",
  "status",
  "list",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectorKind = string;
type VerboseConnectorKind = (typeof VERBOSE_DISPATCHER_KINDS)[number];
type ConnectorSubaction = (typeof VALID_SUBACTIONS)[number];

type ConnectorActionParams = {
  connector?: ConnectorKind;
  action?: ConnectorSubaction;
  subaction?: ConnectorSubaction;
  side?: "owner" | "agent";
  mode?: "local" | "cloud_managed" | "remote";
  // Connector-specific params (passed through to underlying service methods).
  recentLimit?: number;
  query?: string;
  channelId?: string;
  browser?: "chrome" | "firefox" | "safari";
  profileId?: string;
  profileLabel?: string;
  redirectUrl?: string;
  capabilities?: LifeOpsGoogleCapability[];
};

type ConnectorDispatchContext = {
  runtime: IAgentRuntime;
  service: LifeOpsService;
};

type GmailTriageResult = Awaited<ReturnType<LifeOpsService["getGmailTriage"]>>;
type CalendarFeedResult = Awaited<
  ReturnType<LifeOpsService["getCalendarFeed"]>
>;
type GoogleVerifyProbeSkipped = {
  ok: false;
  skipped: true;
  reason: string | undefined;
};

type GoogleVerifyRead = {
  gmail:
    | {
        ok: true;
        count: number;
        summary: GmailTriageResult["summary"];
        messages: GmailTriageResult["messages"];
      }
    | GoogleVerifyProbeSkipped;
  calendar:
    | {
        ok: true;
        count: number;
        events: CalendarFeedResult["events"];
      }
    | GoogleVerifyProbeSkipped;
};

type ConnectorDispatcher = (
  context: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
) => Promise<ActionResult>;

const MESSAGE_CONNECTOR_SOURCE_BY_LIFEOPS_CONNECTOR: Record<string, string> = {
  x: "x",
  telegram: "telegram",
  signal: "signal",
  discord: "discord",
  imessage: "imessage",
  whatsapp: "whatsapp",
  wechat: "wechat",
};

/**
 * Appends the inline-widget marker the chat UI parses into a connector-setup
 * card (`[CONFIG:<pluginId>]`, see packages/ui message-parser-helpers). Only
 * replies whose intent is "configure/set up this connector plugin" carry the
 * marker; connected-status prose stays marker-free so healthy connectors
 * never render a setup card.
 */
function withConfigCard(text: string, pluginId: string): string {
  return `${text}\n\n[CONFIG:${pluginId}]`;
}

/** Google OAuth authorization endpoints only — never elevate arbitrary URLs. */
function isTrustedGoogleOAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.hostname !== "accounts.google.com") return false;
    if (url.port && url.port !== "443") return false;
    return (
      url.pathname === "/o/oauth2/v2/auth" || url.pathname === "/o/oauth2/auth"
    );
  } catch {
    // error-policy:J3 Untrusted URL text is explicitly invalid.
    return false;
  }
}

/**
 * Calendar feed connect phrases must use CALENDAR_SOURCES, not CONNECTOR.
 * Deterministic gate so planner metadata alone cannot strand the user.
 */
function isCalendarFeedConnectPhrase(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const connectVerb = "connect|link|add|setup|set up|authorize|enable";
  if (!new RegExp(`\\b(?:${connectVerb})\\b`).test(normalized)) {
    return false;
  }
  // Vendor calendar shorthand: "google cal", "microsoft calendar", "apple cal".
  if (/\b(google|microsoft|apple)\s+cal(?:endar)?\b/.test(normalized)) {
    return true;
  }
  // Whole-word "calendar" or "cal" near a connect verb. Word boundaries keep
  // "calculation" / "call" from matching bare "cal".
  return new RegExp(
    `\\b(?:${connectVerb})\\b.{0,40}\\b(?:calendar|cal)\\b|\\b(?:calendar|cal)\\b.{0,40}\\b(?:${connectVerb})\\b`,
  ).test(normalized);
}

function messageText(message: Memory): string {
  const content = message.content;
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** Explicit-confirmation cues for the destructive `disconnect` subaction.
 * Mirrors the LifeOps confirmation-cue dialect (life.ts) so the assistant
 * keeps one confirmation vocabulary: a bare "disconnect google" ask carries
 * no cue and gets a question back; "yes" / "yes, disconnect it" /
 * "disconnect google, I'm sure" carries one and executes. */
const CONNECTOR_DISCONNECT_CONFIRM_RE =
  /\b(?:yes|yep|yeah|confirm|confirmed|go ahead|do it|proceed|i'?m sure)\b/i;

/**
 * Short plugin id for the setup card. Message connectors resolve through the
 * existing source mapping; registry-backed connectors use their kind directly
 * (the UI normalizes `@elizaos/plugin-` prefixes, but short ids are canonical).
 */
function connectorConfigPluginId(connector: string): string {
  return MESSAGE_CONNECTOR_SOURCE_BY_LIFEOPS_CONNECTOR[connector] ?? connector;
}

function normalizeConnectorKind(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[- ]/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function listKnownConnectorKinds(runtime: IAgentRuntime): string[] {
  const registry = getConnectorRegistry(runtime);
  const fromRegistry = registry
    ? registry.list().map((contribution) => contribution.kind)
    : [];
  // Verbose dispatcher kinds are always valid (they cover diagnostic verbs
  // like `health` and `browser_bridge` that aren't connector contributions —
  // those still flow through this action). iMessage is wired through the
  // native macOS bridge; surfacing it on non-darwin would just produce
  // confusing planner suggestions.
  const verboseKinds = isDarwin()
    ? VERBOSE_DISPATCHER_KINDS
    : VERBOSE_DISPATCHER_KINDS.filter((kind) => kind !== "imessage");
  return [...new Set([...verboseKinds, ...fromRegistry])];
}

function isValidConnectorKind(runtime: IAgentRuntime, kind: string): boolean {
  return listKnownConnectorKinds(runtime).includes(kind);
}

function normalizeSubaction(value: unknown): ConnectorSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as ConnectorSubaction)
    : null;
}

function normalizeSide(value: unknown): "owner" | "agent" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "owner" || normalized === "agent"
    ? normalized
    : undefined;
}

function mergeParams(
  message: Memory,
  options?: HandlerOptions,
): ConnectorActionParams {
  const params = {
    ...(((options as Record<string, unknown> | undefined)?.parameters ??
      {}) as Record<string, unknown>),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(
      message.content as Record<string, unknown>,
    )) {
      if (params[key] === undefined) {
        params[key] = value;
      }
    }
  }
  return params as ConnectorActionParams;
}

function unsupportedOperation(
  connector: string,
  subaction: ConnectorSubaction,
  detail?: string,
  configPluginId?: string,
): ActionResult {
  const base =
    `[${ACTION_NAME}] ${connector}/${subaction} is not supported by the current LifeOps connector contract.` +
    (detail ? ` ${detail}` : "");
  const text = configPluginId ? withConfigCard(base, configPluginId) : base;
  return {
    success: false,
    text,
    data: {
      actionName: ACTION_NAME,
      connector,
      subaction,
      error: "UNSUPPORTED_OPERATION",
    },
  };
}

function getRuntimeMessageConnector(
  runtime: IAgentRuntime,
  connector: string,
): MessageConnector | null {
  const source = MESSAGE_CONNECTOR_SOURCE_BY_LIFEOPS_CONNECTOR[connector];
  if (!source) {
    return null;
  }
  const runtimeWithConnectors = runtime as IAgentRuntime & {
    getMessageConnectors?: () => MessageConnector[];
  };
  if (typeof runtimeWithConnectors.getMessageConnectors !== "function") {
    return null;
  }
  const normalized = source.trim().toLowerCase();
  return (
    runtimeWithConnectors
      .getMessageConnectors()
      .find(
        (registration) =>
          registration.source.trim().toLowerCase() === normalized &&
          (registration.capabilities.length === 0 ||
            registration.capabilities.includes("send_message")),
      ) ?? null
  );
}

export function registryStatusResult(
  runtime: IAgentRuntime,
  connector: string,
  subaction: ConnectorSubaction,
): ActionResult | null {
  const registration = getRuntimeMessageConnector(runtime, connector);
  if (!registration) {
    return null;
  }
  // Registration alone is not deliverability: a connector with no linked
  // chat context and no routable target kinds cannot actually reach the
  // owner. Reporting connected:true for a bare registration made the model
  // promise "Telegram is live" on a fresh install with nothing linked
  // (#16941 live, first-run channel-fallback).
  const deliverable =
    registration.contexts.length > 0 ||
    registration.supportedTargetKinds.length > 0;
  return {
    success: true,
    text: deliverable
      ? `${registration.label} is registered and has linked chat/user context. Detailed chat/user context is exposed by platform providers.`
      : `${registration.label} is registered, but no chat or delivery route is linked yet — messages cannot reach the owner there until it is connected. Offer in-app delivery meanwhile.`,
    data: {
      actionName: ACTION_NAME,
      connector,
      subaction,
      statusSource: "core_message_connector_registry",
      status: {
        provider: connector,
        source: registration.source,
        label: registration.label,
        connected: deliverable,
        registered: true,
        capabilities: registration.capabilities,
        supportedTargetKinds: registration.supportedTargetKinds,
        contexts: registration.contexts,
        description: registration.description,
        metadata: registration.metadata,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchListAll(
  context: ConnectorDispatchContext,
): Promise<ActionResult> {
  const { runtime, service } = context;
  const registryOrReadStatus = async (
    connector: string,
    readStatus: () => Promise<unknown>,
  ) => {
    const registryStatus = registryStatusResult(runtime, connector, "list")
      ?.data as { status?: unknown } | undefined;
    return registryStatus?.status ?? (await readStatus());
  };
  const [
    google,
    x,
    telegram,
    signal,
    discord,
    imessage,
    whatsapp,
    health,
    browserSettings,
    browserCompanions,
  ] = await Promise.all([
    service.getGoogleConnectorStatus(INTERNAL_URL),
    registryOrReadStatus("x", () => service.getXConnectorStatus()),
    registryOrReadStatus("telegram", () =>
      service.getTelegramConnectorStatus(),
    ),
    registryOrReadStatus("signal", () => service.getSignalConnectorStatus()),
    registryOrReadStatus("discord", () => service.getDiscordConnectorStatus()),
    registryOrReadStatus("imessage", () =>
      service.getIMessageConnectorStatus(),
    ),
    registryOrReadStatus("whatsapp", () =>
      service.getWhatsAppConnectorStatus(),
    ),
    service.getHealthDataConnectorStatuses(INTERNAL_URL),
    service.getBrowserSettings(),
    service.listBrowserCompanions(),
  ]);
  const known = listKnownConnectorKinds(runtime);
  return {
    success: true,
    text: `Listed status for ${known.length} LifeOps connectors.`,
    data: {
      actionName: ACTION_NAME,
      connectorKinds: known,
      connectors: {
        google,
        x,
        telegram,
        signal,
        discord,
        imessage,
        whatsapp,
        health,
        browser_bridge: {
          settings: browserSettings,
          companions: browserCompanions,
        },
      },
    },
  };
}

async function dispatchGoogle(
  { service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      // Pin trusted OAuth URLs and allowlisted config cards as verified
      // user-facing text so the planner cannot paraphrase them away.
      try {
        const response = await service.startGoogleConnector(
          {
            side,
            mode: params.mode,
            capabilities: params.capabilities,
            redirectUrl: params.redirectUrl,
          },
          INTERNAL_URL,
        );
        const authUrl =
          typeof response.authUrl === "string" ? response.authUrl.trim() : "";
        if (!authUrl) {
          return {
            success: false,
            text: "Google connector started but returned no authorization URL. Check OAuth configuration and try again.",
            data: {
              actionName: ACTION_NAME,
              connector: "google",
              subaction,
              error: "GOOGLE_AUTH_URL_MISSING",
              response,
            },
          };
        }
        if (!isTrustedGoogleOAuthUrl(authUrl)) {
          return {
            success: false,
            text: "Google connector returned an untrusted authorization URL. Refusing to surface it.",
            data: {
              actionName: ACTION_NAME,
              connector: "google",
              subaction,
              error: "GOOGLE_AUTH_URL_UNTRUSTED",
            },
          };
        }
        const text = `Open this URL to finish Google connect: ${authUrl}`;
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          data: {
            actionName: ACTION_NAME,
            connector: "google",
            subaction,
            response,
            awaitingUserAction: true,
            awaitingUserInput: true,
          },
        };
      } catch (error) {
        // error-policy:J1 Boundary: expected LifeOps failures become owner
        // handoffs; unexpected errors rethrow into the planner.
        if (error instanceof LifeOpsServiceError) {
          // Prefer stable codes/messages over bare HTTP 503 (outages ≠ config).
          const needsConfig =
            error.code === "google_plugin_unavailable" ||
            /plugin-google-workspace is required|OAuth is not registered|required before starting Google OAuth/i.test(
              error.message,
            );
          if (needsConfig) {
            // Plugin id must match /api/plugins inventory (google-workspace).
            const text = withConfigCard(
              "Google account connection needs Google Workspace enabled and OAuth configured. Open the setup card, then try connect again.",
              "google-workspace",
            );
            return {
              success: false,
              text,
              userFacingText: text,
              verifiedUserFacing: true,
              data: {
                actionName: ACTION_NAME,
                connector: "google",
                subaction,
                status: error.status,
                error: error.code ?? "GOOGLE_CONNECT_FAILED",
                awaitingUserAction: true,
                awaitingUserInput: true,
              },
            };
          }
          return {
            success: false,
            text: "Google connector connect failed. Check connector status and try again.",
            data: {
              actionName: ACTION_NAME,
              connector: "google",
              subaction,
              status: error.status,
              error: error.code ?? "GOOGLE_CONNECT_FAILED",
            },
          };
        }
        // Incomplete GOOGLE_CLIENT_* / redirect config throws a plain Error from
        // readClientConfig — map to the same actionable setup card.
        if (
          error instanceof Error &&
          /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REDIRECT_URI/i.test(
            error.message,
          )
        ) {
          const text = withConfigCard(
            "Google OAuth is incomplete. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI, then try connect again.",
            "google-workspace",
          );
          return {
            success: false,
            text,
            userFacingText: text,
            verifiedUserFacing: true,
            data: {
              actionName: ACTION_NAME,
              connector: "google",
              subaction,
              error: "GOOGLE_OAUTH_CONFIG_INCOMPLETE",
              awaitingUserAction: true,
              awaitingUserInput: true,
            },
          };
        }
        throw error;
      }
    }
    case "disconnect": {
      const status = await service.disconnectGoogleConnector(
        { side, mode: params.mode },
        INTERNAL_URL,
      );
      return {
        success: true,
        text: `Google connector disconnected (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "google",
          subaction,
          status,
        },
      };
    }
    case "status":
    case "list": {
      const status = await service.getGoogleConnectorStatus(
        INTERNAL_URL,
        params.mode,
        side,
      );
      return {
        success: true,
        text: `Google connector status retrieved (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "google",
          subaction,
          status,
        },
      };
    }
    case "verify":
      return await dispatchGoogleVerify(service, side, params);
  }
}

async function dispatchGoogleVerify(
  service: LifeOpsService,
  side: "owner" | "agent",
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const status = await service.getGoogleConnectorStatus(
    INTERNAL_URL,
    params.mode,
    side,
  );
  const capabilities = new Set(status.grantedCapabilities);

  let gmailRead: GoogleVerifyRead["gmail"];
  if (status.connected && capabilities.has("google.gmail.triage")) {
    const triage = await service.getGmailTriage(INTERNAL_URL, {
      mode: params.mode,
      side,
      maxResults: params.recentLimit ?? 10,
      forceSync: true,
    });
    gmailRead = {
      ok: true,
      count: triage.messages.length,
      summary: triage.summary,
      messages: triage.messages,
    };
  } else {
    gmailRead = {
      ok: false,
      skipped: true,
      reason: status.connected
        ? "google.gmail.triage capability not granted"
        : status.reason,
    };
  }

  let calendarRead: GoogleVerifyRead["calendar"];
  if (status.connected && capabilities.has("google.calendar.read")) {
    const now = Date.now();
    const feed = await service.getCalendarFeed(INTERNAL_URL, {
      mode: params.mode,
      side,
      timeMin: new Date(now - 60 * 60 * 1000).toISOString(),
      timeMax: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    calendarRead = {
      ok: true,
      count: feed.events.length,
      events: feed.events,
    };
  } else {
    calendarRead = {
      ok: false,
      skipped: true,
      reason: status.connected
        ? "google.calendar.read capability not granted"
        : status.reason,
    };
  }
  const read: GoogleVerifyRead = { gmail: gmailRead, calendar: calendarRead };

  return {
    success: status.connected,
    text: `Google verify: status=${status.connected ? "connected" : "disconnected"}, gmail=${read.gmail.ok ? "ok" : "skipped"}, calendar=${read.calendar.ok ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "google",
      subaction: "verify",
      status,
      read,
    },
  };
}

async function dispatchX(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      const status = await service.getXConnectorStatus(params.mode, side);
      return {
        success: status.connected,
        text: status.connected
          ? `X is connected through @elizaos/plugin-x (side=${side}).`
          : `X setup is managed by @elizaos/plugin-x (side=${side}). Configure the X connector plugin, then check status again.`,
        data: { actionName: ACTION_NAME, connector: "x", subaction, status },
      };
    }
    case "disconnect": {
      const status = await service.getXConnectorStatus(params.mode, side);
      return {
        success: false,
        text: `X disconnect is managed by @elizaos/plugin-x (side=${side}). Use the X connector plugin setup controls, then check status again.`,
        data: { actionName: ACTION_NAME, connector: "x", subaction, status },
      };
    }
    case "status":
    case "list": {
      const registryStatus = registryStatusResult(runtime, "x", subaction);
      if (registryStatus) {
        return registryStatus;
      }
      const status = await service.getXConnectorStatus(params.mode, side);
      return {
        success: true,
        text: `X connector status retrieved (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "x", subaction, status },
      };
    }
    case "verify":
      return await dispatchXVerify(service, side, params);
  }
}

async function dispatchXVerify(
  service: LifeOpsService,
  side: "owner" | "agent",
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const status = await service.getXConnectorStatus(params.mode, side);
  const limit = params.recentLimit ?? 10;
  const query = params.query?.trim();
  const search =
    query && status.feedRead
      ? {
          ok: true,
          query,
          items: await service.searchXPosts(query, { limit }),
        }
      : query
        ? {
            ok: false,
            query,
            skipped: true,
            reason: "x.read capability not granted",
          }
        : null;
  const inbound = status.dmInbound
    ? await service.readXInboundDms({ limit })
    : [];
  let searchSummary = "skipped";
  const searchItems =
    search && "items" in search && Array.isArray(search.items)
      ? search.items
      : null;
  if (query && searchItems) {
    const hitCount = searchItems.length;
    searchSummary = `${hitCount} hit${hitCount === 1 ? "" : "s"}`;
  }
  return {
    success: status.connected,
    text: `X verify: status=${status.connected ? "connected" : "disconnected"}, read=${inbound.length} inbound DM${inbound.length === 1 ? "" : "s"}, search=${searchSummary}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "x",
      subaction: "verify",
      status,
      read: { ok: status.dmInbound, count: inbound.length, messages: inbound },
      search,
    },
  };
}

async function dispatchHealth(
  { service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "status":
    case "list": {
      const [bridge, connectors] = await Promise.all([
        service.getHealthConnectorStatus(),
        service.getHealthDataConnectorStatuses(INTERNAL_URL, params.mode, side),
      ]);
      const connectedProviderCount = connectors.filter(
        (connector) => connector.connected,
      ).length;
      return {
        success: true,
        text: `Health connector status retrieved (${connectedProviderCount} connected provider${connectedProviderCount === 1 ? "" : "s"}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "health",
          subaction,
          bridge,
          connectors,
        },
      };
    }
    case "connect":
      return unsupportedOperation(
        "health",
        subaction,
        "Use LifeOps Settings to choose Strava, Fitbit, Withings, or Oura before starting OAuth.",
      );
    case "disconnect":
      return unsupportedOperation(
        "health",
        subaction,
        "Disconnect a specific Strava, Fitbit, Withings, or Oura provider from LifeOps Settings.",
      );
    case "verify": {
      const [bridge, connectors] = await Promise.all([
        service.getHealthConnectorStatus(),
        service.getHealthDataConnectorStatuses(INTERNAL_URL, params.mode, side),
      ]);
      const connectedProviderCount = connectors.filter(
        (item) => item.connected,
      ).length;
      return {
        success: bridge.available || connectedProviderCount > 0,
        text: `Health verify: bridge=${bridge.available ? "available" : "unavailable"}, connectedProviders=${connectedProviderCount}.`,
        data: {
          actionName: ACTION_NAME,
          connector: "health",
          subaction,
          bridge,
          connectors,
        },
      };
    }
  }
}

async function dispatchTelegram(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      const status = await service.getTelegramConnectorStatus(side);
      const base = status.connected
        ? `Telegram is connected through @elizaos/plugin-telegram (side=${side}).`
        : `Set up Telegram below — pick OAuth/cloud gateway, a bot token, or your personal account.`;
      return {
        success: status.connected,
        text: status.connected
          ? base
          : withConfigCard(base, connectorConfigPluginId("telegram")),
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          status,
        },
      };
    }
    case "disconnect": {
      const status = await service.getTelegramConnectorStatus(side);
      return {
        success: false,
        text: `Telegram disconnect is managed by @elizaos/plugin-telegram (side=${side}). Use the Telegram connector plugin setup controls, then check status again.`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          status,
        },
      };
    }
    case "verify": {
      const response = await service.verifyTelegramConnector({
        side,
        recentLimit: params.recentLimit,
      });
      return {
        success: response.read.ok,
        text: `Telegram verify: read=${response.read.ok ? "ok" : "fail"}.`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          response,
        },
      };
    }
    case "status":
    case "list": {
      const registryStatus = registryStatusResult(
        runtime,
        "telegram",
        subaction,
      );
      if (registryStatus) {
        return registryStatus;
      }
      const status = await service.getTelegramConnectorStatus(side);
      return {
        success: true,
        text: `Telegram connector status retrieved (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          status,
        },
      };
    }
  }
}

async function dispatchSignal(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      const status = await service.getSignalConnectorStatus(side);
      return {
        success: false,
        text: "Signal is unavailable until elizaOS owns a legal, bundled, in-process transport.",
        data: {
          actionName: ACTION_NAME,
          connector: "signal",
          subaction,
          status,
        },
      };
    }
    case "disconnect": {
      const status = await service.getSignalConnectorStatus(side);
      return {
        success: false,
        text: `Signal is unavailable, so there is no active connector to disconnect (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "signal",
          subaction,
          status,
        },
      };
    }
    case "status":
    case "list": {
      const registryStatus = registryStatusResult(runtime, "signal", subaction);
      if (registryStatus) {
        return registryStatus;
      }
      const status = await service.getSignalConnectorStatus(side);
      return {
        success: true,
        text: `Signal connector status retrieved (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "signal",
          subaction,
          status,
        },
      };
    }
    case "verify":
      return await dispatchSignalVerify(service, side, params);
  }
}

async function dispatchSignalVerify(
  service: LifeOpsService,
  side: "owner" | "agent",
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const limit = params.recentLimit ?? 10;
  const status = await service.getSignalConnectorStatus(side);
  let messages: Awaited<ReturnType<LifeOpsService["readSignalInbound"]>> = [];
  let readError: string | null = null;
  if (status.inbound) {
    try {
      messages = await service.readSignalInbound(limit, side);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  } else {
    readError = "Signal direct transport is unavailable.";
  }
  const readOk = readError === null;
  return {
    success: status.connected && readOk,
    text: `Signal verify: status=${status.connected ? "connected" : "disconnected"}, read=${readOk ? `${messages.length} message${messages.length === 1 ? "" : "s"}` : "failed"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "signal",
      subaction: "verify",
      status,
      read: { ok: readOk, error: readError, count: messages.length, messages },
    },
  };
}

async function dispatchDiscord(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      const status = await service.getDiscordConnectorStatus(side);
      const base = status.connected
        ? `Discord is connected through @elizaos/plugin-discord (side=${side}).`
        : `Set up Discord below — sign in with the Eliza Cloud OAuth gateway, pair the desktop app, or paste a bot token.`;
      return {
        success: status.connected,
        text: status.connected
          ? base
          : withConfigCard(base, connectorConfigPluginId("discord")),
        data: {
          actionName: ACTION_NAME,
          connector: "discord",
          subaction,
          status,
        },
      };
    }
    case "disconnect": {
      const status = await service.getDiscordConnectorStatus(side);
      return {
        success: false,
        text: `Discord disconnect is managed by @elizaos/plugin-discord (side=${side}). Use the Discord connector plugin setup controls, then check status again.`,
        data: {
          actionName: ACTION_NAME,
          connector: "discord",
          subaction,
          status,
        },
      };
    }
    case "status":
    case "list": {
      const registryStatus = registryStatusResult(
        runtime,
        "discord",
        subaction,
      );
      if (registryStatus) {
        return registryStatus;
      }
      const status = await service.getDiscordConnectorStatus(side);
      return {
        success: true,
        text: `Discord connector status retrieved (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "discord",
          subaction,
          status,
        },
      };
    }
    case "verify":
      return await dispatchDiscordVerify(service, side, params);
  }
}

async function dispatchDiscordVerify(
  service: LifeOpsService,
  side: "owner" | "agent",
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const status = await service.getDiscordConnectorStatus(side);
  const query = params.query?.trim();
  const hits = query
    ? await service.searchDiscordMessages({
        side,
        query,
        channelId: params.channelId,
      })
    : [];
  return {
    success: status.connected,
    text: `Discord verify: status=${status.connected ? "connected" : "disconnected"}, search=${query ? `${hits.length} hit${hits.length === 1 ? "" : "s"}` : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "discord",
      subaction: "verify",
      status,
      search: query ? { ok: true, query, count: hits.length, hits } : null,
    },
  };
}

async function dispatchIMessage(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  if (!isDarwin()) {
    return darwinUnavailableActionResult({
      actionName: ACTION_NAME,
      connector: "imessage",
      subaction,
      feature: "iMessage",
    });
  }
  switch (subaction) {
    case "status":
    case "list": {
      const registryStatus = registryStatusResult(
        runtime,
        "imessage",
        subaction,
      );
      if (registryStatus) {
        return registryStatus;
      }
      const status = await service.getIMessageConnectorStatus();
      return {
        success: true,
        text: `iMessage connector status retrieved.`,
        data: {
          actionName: ACTION_NAME,
          connector: "imessage",
          subaction,
          status,
        },
      };
    }
    case "connect": {
      const status = await service.getIMessageConnectorStatus();
      const base = status.connected
        ? "iMessage is connected through the native macOS bridge."
        : "Set up iMessage below — read chat.db directly (Full Disk Access), bridge via BlueBubbles, or use the Blooio cloud gateway.";
      return {
        success: status.connected,
        text: status.connected
          ? base
          : withConfigCard(base, connectorConfigPluginId("imessage")),
        data: {
          actionName: ACTION_NAME,
          connector: "imessage",
          subaction,
          status,
        },
      };
    }
    case "disconnect":
      return unsupportedOperation(
        "imessage",
        subaction,
        "iMessage disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return await dispatchIMessageVerify(service, params);
  }
}

async function dispatchIMessageVerify(
  service: LifeOpsService,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const limit = params.recentLimit ?? 10;
  const [status, messages] = await Promise.all([
    service.getIMessageConnectorStatus(),
    service.readIMessages({ limit }),
  ]);
  return {
    success: status.connected,
    text: `iMessage verify: status=${status.connected ? "connected" : "disconnected"}, read=${messages.length} message${messages.length === 1 ? "" : "s"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "imessage",
      subaction: "verify",
      status,
      read: { ok: true, count: messages.length, messages },
    },
  };
}

async function dispatchWhatsApp(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  switch (subaction) {
    case "status":
    case "list": {
      const registryStatus = registryStatusResult(
        runtime,
        "whatsapp",
        subaction,
      );
      if (registryStatus) {
        return registryStatus;
      }
      const status = await service.getWhatsAppConnectorStatus();
      return {
        success: true,
        text: `WhatsApp connector status retrieved.`,
        data: {
          actionName: ACTION_NAME,
          connector: "whatsapp",
          subaction,
          status,
        },
      };
    }
    case "connect": {
      const registryStatus = registryStatusResult(
        runtime,
        "whatsapp",
        subaction,
      );
      if (registryStatus) {
        return registryStatus;
      }
      const base =
        "Set up WhatsApp below — scan a QR code from your phone or paste Business Cloud API credentials.";
      return {
        success: false,
        text: withConfigCard(base, connectorConfigPluginId("whatsapp")),
        data: {
          actionName: ACTION_NAME,
          connector: "whatsapp",
          subaction,
          status: { provider: "whatsapp", connected: false, registered: false },
        },
      };
    }
    case "disconnect":
      return unsupportedOperation(
        "whatsapp",
        subaction,
        "WhatsApp disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return await dispatchWhatsAppVerify(service, params);
  }
}

async function dispatchWhatsAppVerify(
  service: LifeOpsService,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const limit = params.recentLimit ?? 10;
  const status = await service.getWhatsAppConnectorStatus();
  const recent = await service.pullWhatsAppRecent(limit);
  return {
    success: status.connected,
    text: `WhatsApp verify: status=${status.connected ? "connected" : "disconnected"}, read=${recent.count} message${recent.count === 1 ? "" : "s"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "whatsapp",
      subaction: "verify",
      status,
      read: { ok: true, count: recent.count, messages: recent.messages },
    },
  };
}

/**
 * WeChat is configured entirely through `@elizaos/plugin-wechat` (WECHAT_API_KEY
 * + WECHAT_PROXY_URL under `config.connectors.wechat`); LifeOpsService owns no
 * WeChat state, so this dispatcher reads live status from the core message
 * connector registry when the plugin is loaded and otherwise emits the setup
 * card for the owner to fill in. It never fabricates a connected/disconnected
 * verdict it did not observe.
 */
async function dispatchWeChat(
  { runtime }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  _params: ConnectorActionParams,
): Promise<ActionResult> {
  const registryStatus = registryStatusResult(runtime, "wechat", subaction);
  switch (subaction) {
    case "connect": {
      if (registryStatus) {
        return registryStatus;
      }
      const base =
        "Set up WeChat below — paste your WeChat proxy API key and proxy URL to route messages through @elizaos/plugin-wechat.";
      return {
        success: false,
        text: withConfigCard(base, connectorConfigPluginId("wechat")),
        data: {
          actionName: ACTION_NAME,
          connector: "wechat",
          subaction,
          status: { provider: "wechat", connected: false, registered: false },
        },
      };
    }
    case "status":
    case "list": {
      if (registryStatus) {
        return registryStatus;
      }
      return {
        success: true,
        text: "WeChat is not connected. Configure @elizaos/plugin-wechat (WECHAT_API_KEY + WECHAT_PROXY_URL) to enable it.",
        data: {
          actionName: ACTION_NAME,
          connector: "wechat",
          subaction,
          status: { provider: "wechat", connected: false, registered: false },
        },
      };
    }
    case "disconnect":
      return unsupportedOperation(
        "wechat",
        subaction,
        "WeChat disconnect is managed by @elizaos/plugin-wechat. Clear the WeChat connector config, then check status again.",
      );
    case "verify": {
      if (registryStatus) {
        return registryStatus;
      }
      return {
        success: false,
        text: "WeChat verify: not connected. Configure @elizaos/plugin-wechat first.",
        data: {
          actionName: ACTION_NAME,
          connector: "wechat",
          subaction,
          status: { provider: "wechat", connected: false, registered: false },
        },
      };
    }
  }
}

async function dispatchBrowserBridge(
  { service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  _params: ConnectorActionParams,
): Promise<ActionResult> {
  switch (subaction) {
    case "connect": {
      const [settings, companions] = await Promise.all([
        service.getBrowserSettings(),
        service.listBrowserCompanions(),
      ]);
      return {
        success: companions.length > 0,
        text:
          companions.length > 0
            ? `Browser bridge is configured through @elizaos/plugin-browser (${companions.length} companion${companions.length === 1 ? "" : "s"}).`
            : "Browser bridge setup is managed by @elizaos/plugin-browser. Configure the browser companion plugin, then check status again.",
        data: {
          actionName: ACTION_NAME,
          connector: "browser_bridge",
          subaction,
          settings,
          companions,
        },
      };
    }
    case "status": {
      const [settings, companions] = await Promise.all([
        service.getBrowserSettings(),
        service.listBrowserCompanions(),
      ]);
      return {
        success: true,
        text: `Browser bridge status retrieved (${companions.length} companion${companions.length === 1 ? "" : "s"}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "browser_bridge",
          subaction,
          settings,
          companions,
        },
      };
    }
    case "list": {
      const companions = await service.listBrowserCompanions();
      return {
        success: true,
        text: `${companions.length} browser companion${companions.length === 1 ? "" : "s"} listed.`,
        data: {
          actionName: ACTION_NAME,
          connector: "browser_bridge",
          subaction,
          companions,
        },
      };
    }
    case "disconnect":
      return unsupportedOperation(
        "browser_bridge",
        subaction,
        "Browser companion disconnect is not exposed by LifeOpsService.",
      );
    case "verify": {
      const [settings, companions] = await Promise.all([
        service.getBrowserSettings(),
        service.listBrowserCompanions(),
      ]);
      const connected = companions.some(
        (companion) => companion.connectionState === "connected",
      );
      return {
        success: connected,
        text: `Browser bridge verify: ${connected ? "connected" : "disconnected"} (${companions.length} companion${companions.length === 1 ? "" : "s"}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "browser_bridge",
          subaction,
          settings,
          companions,
          verification: {
            connected,
          },
        },
      };
    }
  }
}

/**
 * Verbose dispatchers cover the rich verify probes (gmail+calendar reads,
 * inbound DM checks, browser companion enumeration). Connectors registered
 * via `ConnectorRegistry` that lack a verbose dispatcher fall back to
 * {@link dispatchGenericRegistry} which exercises the registry contract verbs
 * (`start`/`disconnect`/`verify`/`status`/`send`) directly.
 */
const VERBOSE_DISPATCHERS: Record<VerboseConnectorKind, ConnectorDispatcher> = {
  google: dispatchGoogle,
  x: dispatchX,
  telegram: dispatchTelegram,
  signal: dispatchSignal,
  discord: dispatchDiscord,
  imessage: dispatchIMessage,
  whatsapp: dispatchWhatsApp,
  wechat: dispatchWeChat,
  health: dispatchHealth,
  browser_bridge: dispatchBrowserBridge,
};

async function dispatchGenericRegistry(
  context: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  _params: ConnectorActionParams,
  connectorKind: string,
): Promise<ActionResult> {
  const registry = getConnectorRegistry(context.runtime);
  const contribution = registry?.get(connectorKind);
  if (!contribution) {
    return {
      success: false,
      text: `[${ACTION_NAME}] no connector contribution registered for "${connectorKind}".`,
      data: {
        actionName: ACTION_NAME,
        connector: connectorKind,
        error: "CONNECTOR_NOT_REGISTERED",
      },
    };
  }
  switch (subaction) {
    case "connect": {
      await contribution.start();
      return {
        success: true,
        text: `${contribution.describe.label} start invoked.`,
        data: {
          actionName: ACTION_NAME,
          connector: connectorKind,
          subaction,
        },
      };
    }
    case "disconnect": {
      await contribution.disconnect();
      return {
        success: true,
        text: `${contribution.describe.label} disconnected.`,
        data: {
          actionName: ACTION_NAME,
          connector: connectorKind,
          subaction,
        },
      };
    }
    case "verify": {
      const verified = await contribution.verify();
      return {
        success: verified,
        text: `${contribution.describe.label} verify: connected=${verified}.`,
        data: {
          actionName: ACTION_NAME,
          connector: connectorKind,
          subaction,
          verified,
        },
      };
    }
    case "status":
    case "list": {
      const status = await contribution.status();
      return {
        success: true,
        text: `${contribution.describe.label} status: ${status.state}.`,
        data: {
          actionName: ACTION_NAME,
          connector: connectorKind,
          subaction,
          status,
          capabilities: contribution.capabilities,
          modes: contribution.modes,
          requiresApproval: contribution.requiresApproval ?? false,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const connectorAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    // Prefer CONNECT_GOOGLE_ACCOUNT for account-level Google OAuth. Calendar
    // feed connect phrases ("connect google calendar") must route to
    // CALENDAR_SOURCES — CONNECT_GOOGLE remains as a legacy alias only.
    "CONNECT_GOOGLE_ACCOUNT",
    "CONNECT_GOOGLE",
    "CONNECT_TELEGRAM",
    "CONNECT_DISCORD",
    "DISCONNECT_SERVICE",
    "CHECK_CONNECTION",
    "SERVICE_STATUS",
    // PRD action-catalog alias. NotificationIntent endpoint resolution maps
    // to CONNECTOR.list + CONNECTOR.status (the registered endpoints).
    // See packages/docs/action-prd-map.md.
    "NOTIFICATION_RESOLVE_ENDPOINTS",
  ],
  tags: [
    "domain:meta",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:remote-api",
    "surface:internal",
  ],
  description:
    "Installed connector account state: connect, disconnect, verify, status, list. " +
    `Actions: ${VALID_SUBACTIONS.join(", ")}. ` +
    "External accounts: Google (Gmail/Drive package OAuth), Telegram, Discord, Slack, etc. " +
    "Do NOT use this for 'connect Google Calendar' / calendar feed authorization — use CALENDAR_SOURCES. " +
    "Connector kinds from runtime ConnectorRegistry; verify active upstream API probe. " +
    "Plugin install/uninstall/configure -> use PLUGIN.",
  descriptionCompressed:
    "CONNECTOR accounts: connect|disconnect|verify|status|list; calendar feed connect -> CALENDAR_SOURCES; plugin install -> PLUGIN",
  contexts: [
    "connectors",
    "settings",
    "email",
    "messaging",
    "contacts",
    "health",
    "browser",
  ],
  roleGate: { minRole: "OWNER" },
  routingHint:
    "connect/link Google Calendar or any calendar source/feed authorization -> CALENDAR_SOURCES; Gmail/Drive/account Google OAuth without calendar-feed wording -> CONNECTOR; package install/config -> PLUGIN",
  suppressPostActionContinuation: true,

  validate: async (_runtime, message) => {
    // Exclude CONNECTOR from selection for calendar-feed connect phrasing so
    // the planner must use CALENDAR_SOURCES instead of CONNECT_GOOGLE.
    return !isCalendarFeedConnectPhrase(messageText(message));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return {
        success: false,
        text: "Connector account actions are restricted to the owner.",
        data: { actionName: ACTION_NAME, error: "PERMISSION_DENIED" },
      };
    }

    if (isCalendarFeedConnectPhrase(messageText(message))) {
      return {
        success: false,
        text: "Calendar feed connection uses CALENDAR_SOURCES, not CONNECTOR. Call CALENDAR_SOURCES with operation=connect and provider=google|microsoft|apple_calendar.",
        data: {
          actionName: ACTION_NAME,
          error: "USE_CALENDAR_SOURCES",
          redirectAction: "CALENDAR_SOURCES",
        },
      };
    }

    const merged = mergeParams(message, options);
    if (merged.action === undefined && merged.subaction !== undefined) {
      merged.action = merged.subaction;
    }
    const params = (await extractActionParamsViaLlm<ConnectorActionParams>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: connectorAction.description,
      paramSchema: connectorAction.parameters ?? [],
      existingParams: merged,
      requiredFields: ["action"],
    })) as ConnectorActionParams;
    const subaction = normalizeSubaction(params.action ?? params.subaction);
    if (!subaction) {
      return {
        success: false,
        text: `[${ACTION_NAME}] missing action; choose one of ${VALID_SUBACTIONS.join(" | ")}.`,
        data: {
          actionName: ACTION_NAME,
          error: "MISSING_ACTION",
          validSubactions: [...VALID_SUBACTIONS],
        },
      };
    }
    // F33: `disconnect` revokes a live grant — destructive and not instantly
    // reversible (re-auth may need the owner's device). It previously executed
    // on the FIRST ask with no gate (live matrix F33). Require an explicit
    // confirmation cue in the owner's own message: the bare ask gets a
    // question back; the follow-up ("yes" / "yes, disconnect it") re-invokes
    // with the cue present and executes.
    if (
      subaction === "disconnect" &&
      !CONNECTOR_DISCONNECT_CONFIRM_RE.test(messageText(message))
    ) {
      const connectorLabel = params.connector ?? "that connector";
      return {
        success: false,
        text: `Disconnecting ${connectorLabel} revokes its access grant, and restoring it may require re-authenticating from your device. Confirm and I'll disconnect it.`,
        data: {
          actionName: ACTION_NAME,
          connector: params.connector,
          subaction,
          requiresConfirmation: true,
          awaitingUserInput: true,
        },
      };
    }
    const legacyVerifySend = params as ConnectorActionParams & {
      sendTarget?: unknown;
      sendMessage?: unknown;
    };
    if (
      subaction === "verify" &&
      (legacyVerifySend.sendTarget !== undefined ||
        legacyVerifySend.sendMessage !== undefined)
    ) {
      return {
        success: false,
        text:
          `[${ACTION_NAME}] connector verification is read-only. ` +
          "Draft an ordinary message and obtain owner approval before testing outbound delivery.",
        data: {
          actionName: ACTION_NAME,
          subaction,
          error: "VERIFY_SEND_REQUIRES_APPROVAL",
        },
      };
    }
    const service = new LifeOpsService(runtime);
    const dispatchContext = { runtime, service };

    // `list` with no connector means "list all connectors".
    const connector = normalizeConnectorKind(params.connector);
    if (subaction === "list" && !connector) {
      try {
        return await dispatchListAll(dispatchContext);
      } catch (error) {
        if (error instanceof LifeOpsServiceError) {
          return {
            success: false,
            text: error.message,
            data: { actionName: ACTION_NAME, status: error.status },
          };
        }
        throw error;
      }
    }

    const known = listKnownConnectorKinds(runtime);
    if (!connector) {
      return {
        success: false,
        text: `[${ACTION_NAME}] missing connector; choose one of ${known.join(" | ")}.`,
        data: {
          actionName: ACTION_NAME,
          error: "MISSING_CONNECTOR",
          validConnectors: known,
        },
      };
    }

    if (!isValidConnectorKind(runtime, connector)) {
      return {
        success: false,
        text: `[${ACTION_NAME}] unknown connector "${connector}"; choose one of ${known.join(" | ")}.`,
        data: {
          actionName: ACTION_NAME,
          error: "UNKNOWN_CONNECTOR",
          connector,
          validConnectors: known,
        },
      };
    }

    try {
      const verboseDispatcher = (
        VERBOSE_DISPATCHERS as Record<string, ConnectorDispatcher | undefined>
      )[connector];
      if (verboseDispatcher) {
        return await verboseDispatcher(dispatchContext, subaction, params);
      }
      return await dispatchGenericRegistry(
        dispatchContext,
        subaction,
        params,
        connector,
      );
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        return {
          success: false,
          text: error.message,
          data: {
            actionName: ACTION_NAME,
            connector,
            subaction,
            status: error.status,
          },
        };
      }
      throw error;
    }
  },

  parameters: [
    {
      name: "connector",
      description:
        "ConnectorRegistry kind: google, x, telegram, signal, discord, imessage, whatsapp, wechat, twilio, calendly, duffel, health, browser_bridge. Optional action=list.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "action",
      description:
        "connect auth/pairing; disconnect revoke+clear grant; verify active read-only upstream probe; status/list read-only diagnostics. Omit ok: handler LLM-extracts.",
      required: false,
      schema: { type: "string" as const, enum: [...VALID_SUBACTIONS] },
    },
    {
      name: "side",
      description: "owner | agent. Defaults to owner.",
      required: false,
      schema: { type: "string" as const, enum: ["owner", "agent"] },
    },
    {
      name: "mode",
      description:
        "local | cloud_managed | remote. Default connector-specific.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["local", "cloud_managed", "remote"],
      },
    },
    {
      name: "recentLimit",
      description: "verify only: recent messages/dialogs read limit.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "query",
      description:
        "Discord verify only: search text for browser-message reads.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "channelId",
      description:
        "Discord verify only: optional channel scope for the read-only search.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "browser",
      description: "browser_bridge connect only: chrome | firefox | safari.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["chrome", "firefox", "safari"],
      },
    },
    {
      name: "profileId",
      description: "browser_bridge connect only: profile id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "profileLabel",
      description: "browser_bridge connect only: profile label.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "redirectUrl",
      description: "google/x connect only: OAuth redirect URL override.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me the status of all my LifeOps connectors." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll list status across Google, X, Telegram, Signal, Discord, iMessage, WhatsApp, and Browser Bridge.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Connect my Google account." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll start the plugin-google-workspace account OAuth flow and return the auth URL.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Disconnect Telegram." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll disconnect the Telegram grant and clear local session state.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Verify Telegram by sending a self-test to my saved messages.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll probe the Telegram connector with a read + send check and report the results.",
        },
      },
    ],
  ] as ActionExample[][],
};
