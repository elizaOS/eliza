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
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { INTERNAL_URL } from "../lifeops/access.js";
import { getConnectorRegistry } from "../lifeops/connectors/index.js";

const ACTION_NAME = "CONNECTOR";

/**
 * Connector kinds the action's verbose dispatcher table understands.
 *
 * The W2-B migration replaced the old hardcoded `VALID_CONNECTORS` enum with
 * `ConnectorRegistry`-driven validation. The values below are kept narrow so
 * the verbose-result dispatchers (with rich provider-specific verify probes)
 * keep their typed surface; any connector registered via `ConnectorRegistry`
 * but not present here resolves through the generic registry-backed
 * fallback dispatcher.
 */
const VERBOSE_DISPATCHER_KINDS = [
  "google",
  "x",
  "telegram",
  "signal",
  "discord",
  "imessage",
  "whatsapp",
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
  sendTarget?: string;
  sendMessage?: string;
  browser?: "chrome" | "safari";
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
type RegistrySendVerificationResult = NonNullable<
  Awaited<ReturnType<typeof sendVerificationThroughRegistry>>
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
};

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
  // like `health` and `browser_bridge` that aren't connector contributions
  // in the W1-F sense — those still flow through this action).
  return [...new Set([...VERBOSE_DISPATCHER_KINDS, ...fromRegistry])];
}

function isValidConnectorKind(
  runtime: IAgentRuntime,
  kind: string,
): boolean {
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
): ActionResult {
  const text =
    `[${ACTION_NAME}] ${connector}/${subaction} is not supported by the current LifeOps connector contract.` +
    (detail ? ` ${detail}` : "");
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

function missingParamResult(
  connector: string,
  subaction: ConnectorSubaction,
  missing: string[],
): ActionResult {
  return {
    success: false,
    text: `[${ACTION_NAME}] ${connector}/${subaction} requires: ${missing.join(", ")}.`,
    data: {
      actionName: ACTION_NAME,
      connector,
      subaction,
      error: "MISSING_PARAMS",
      missing,
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

function registryStatusResult(
  runtime: IAgentRuntime,
  connector: string,
  subaction: ConnectorSubaction,
): ActionResult | null {
  const registration = getRuntimeMessageConnector(runtime, connector);
  if (!registration) {
    return null;
  }
  return {
    success: true,
    text: `${registration.label} is registered in the core message connector registry. Detailed chat/user context is exposed by platform providers.`,
    data: {
      actionName: ACTION_NAME,
      connector,
      subaction,
      statusSource: "core_message_connector_registry",
      status: {
        provider: connector,
        source: registration.source,
        label: registration.label,
        connected: true,
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

async function sendVerificationThroughRegistry(args: {
  runtime: IAgentRuntime;
  connector: string;
  target: string | undefined;
  text: string;
}): Promise<
  | {
      ok: true;
      routedBy: "core_message_connector_registry";
      source: string;
      target: string;
    }
  | {
      ok: false;
      routedBy: "core_message_connector_registry";
      source: string;
      target: string;
      error: string;
    }
  | null
> {
  const target = args.target?.trim();
  if (!target) {
    return null;
  }
  const registration = getRuntimeMessageConnector(args.runtime, args.connector);
  if (!registration) {
    return null;
  }
  try {
    await args.runtime.sendMessageToTarget(
      {
        source: registration.source,
        channelId: target,
      } as Parameters<typeof args.runtime.sendMessageToTarget>[0],
      {
        text: args.text,
        source: registration.source,
        metadata: {
          actionName: ACTION_NAME,
          verification: true,
        },
      },
    );
    return {
      ok: true,
      routedBy: "core_message_connector_registry",
      source: registration.source,
      target,
    };
  } catch (error) {
    return {
      ok: false,
      routedBy: "core_message_connector_registry",
      source: registration.source,
      target,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
      const response = await service.startGoogleConnector(
        {
          side,
          mode: params.mode,
          capabilities: params.capabilities,
          redirectUrl: params.redirectUrl,
        },
        INTERNAL_URL,
      );
      return {
        success: true,
        text: response.authUrl
          ? `Open this URL to finish Google connect: ${response.authUrl}`
          : `Google connector started for side=${side}, mode=${response.mode}.`,
        data: {
          actionName: ACTION_NAME,
          connector: "google",
          subaction,
          response,
        },
      };
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

  const send = params.sendTarget
    ? await service.sendGmailMessage(INTERNAL_URL, {
        mode: params.mode,
        side,
        to: [params.sendTarget],
        subject: "LifeOps Google connector verification",
        bodyText:
          params.sendMessage ?? "LifeOps Google connector verification ping.",
        confirmSend: true,
      })
    : null;

  return {
    success: status.connected && (!params.sendTarget || send?.ok === true),
    text: `Google verify: status=${status.connected ? "connected" : "disconnected"}, gmail=${read.gmail.ok ? "ok" : "skipped"}, calendar=${read.calendar.ok ? "ok" : "skipped"}, send=${send ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "google",
      subaction: "verify",
      status,
      read,
      send,
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
      const response = await service.startXConnector({
        side,
        mode: params.mode,
        redirectUrl: params.redirectUrl,
      });
      return {
        success: true,
        text: response.authUrl
          ? `Open this URL to finish X connect: ${response.authUrl}`
          : `X connector started for side=${side}, mode=${response.mode}.`,
        data: { actionName: ACTION_NAME, connector: "x", subaction, response },
      };
    }
    case "disconnect": {
      const status = await service.disconnectXConnector({
        side,
        mode: params.mode,
      });
      return {
        success: true,
        text: `X connector disconnected (side=${side}).`,
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
      return await dispatchXVerify(runtime, service, side, params);
  }
}

async function dispatchXVerify(
  runtime: IAgentRuntime,
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
  const sendText =
    params.sendMessage ?? "LifeOps X connector verification ping.";
  const send =
    (await sendVerificationThroughRegistry({
      runtime,
      connector: "x",
      target: params.sendTarget,
      text: sendText,
    })) ??
    (params.sendTarget
      ? await service.sendXDirectMessage({
          participantId: params.sendTarget,
          text: sendText,
          mode: params.mode,
          side,
          confirmSend: true,
        })
      : null);
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
    success: status.connected && (!params.sendTarget || send?.ok === true),
    text: `X verify: status=${status.connected ? "connected" : "disconnected"}, read=${inbound.length} inbound DM${inbound.length === 1 ? "" : "s"}, search=${searchSummary}, send=${send ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "x",
      subaction: "verify",
      status,
      read: { ok: status.dmInbound, count: inbound.length, messages: inbound },
      search,
      send,
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
      return {
        success: status.connected,
        text: status.connected
          ? `Telegram is connected through @elizaos/plugin-telegram (side=${side}).`
          : `Telegram connection is managed by @elizaos/plugin-telegram (side=${side}). Configure the Telegram connector plugin, then check status again.`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          status,
        },
      };
    }
    case "disconnect": {
      const status = await service.disconnectTelegram(side);
      return {
        success: true,
        text: `Telegram disconnected (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          status,
        },
      };
    }
    case "verify": {
      const registrySend = await sendVerificationThroughRegistry({
        runtime,
        connector: "telegram",
        target: params.sendTarget,
        text:
          params.sendMessage ?? "LifeOps Telegram connector verification ping.",
      });
      const response = await service.verifyTelegramConnector({
        side,
        recentLimit: params.recentLimit,
        sendTarget: registrySend ? undefined : params.sendTarget,
        sendMessage: registrySend ? undefined : params.sendMessage,
      });
      const send = registrySend ?? response.send;
      return {
        success: response.read.ok && send.ok,
        text: `Telegram verify: read=${response.read.ok ? "ok" : "fail"}, send=${send.ok ? "ok" : "fail"}.`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          response: { ...response, send },
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
        success: status.connected,
        text: status.connected
          ? `Signal is connected through @elizaos/plugin-signal (side=${side}).`
          : `Signal pairing is managed by @elizaos/plugin-signal (side=${side}). Configure the Signal connector plugin, then check status again.`,
        data: {
          actionName: ACTION_NAME,
          connector: "signal",
          subaction,
          status,
        },
      };
    }
    case "disconnect": {
      const status = await service.disconnectSignal(side);
      return {
        success: true,
        text: `Signal disconnected (side=${side}).`,
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
      return await dispatchSignalVerify(runtime, service, side, params);
  }
}

async function dispatchSignalVerify(
  runtime: IAgentRuntime,
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
    readError = "Signal plugin inbound read is unavailable.";
  }
  const sendText =
    params.sendMessage ?? "LifeOps Signal connector verification ping.";
  let send:
    | Awaited<ReturnType<LifeOpsService["sendSignalMessage"]>>
    | RegistrySendVerificationResult
    | null = null;
  let sendError: string | null = null;
  if (params.sendTarget) {
    try {
      send =
        (await sendVerificationThroughRegistry({
          runtime,
          connector: "signal",
          target: params.sendTarget,
          text: sendText,
        })) ??
        (await service.sendSignalMessage({
          side,
          recipient: params.sendTarget,
          text: sendText,
        }));
    } catch (error) {
      sendError = error instanceof Error ? error.message : String(error);
    }
  }
  const readOk = readError === null;
  const sendOk = !params.sendTarget || send?.ok === true;
  return {
    success: status.connected && readOk && sendOk,
    text: `Signal verify: status=${status.connected ? "connected" : "disconnected"}, read=${readOk ? `${messages.length} message${messages.length === 1 ? "" : "s"}` : "failed"}, send=${params.sendTarget ? (sendOk ? "ok" : "failed") : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "signal",
      subaction: "verify",
      status,
      read: { ok: readOk, error: readError, count: messages.length, messages },
      send: send
        ? { ...send, error: sendError }
        : { ok: !params.sendTarget, error: sendError },
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
      const status = await service.authorizeDiscordConnector(side);
      return {
        success: side === "agent" ? status.connected : true,
        text:
          side === "agent"
            ? status.connected
              ? "Agent Discord is connected through @elizaos/plugin-discord."
              : "Agent Discord is managed by @elizaos/plugin-discord. Configure and enable the Discord bot connector, then check status again."
            : `Discord browser connector authorized (side=${side}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "discord",
          subaction,
          status,
        },
      };
    }
    case "disconnect": {
      const status = await service.disconnectDiscord(side);
      return {
        success: true,
        text: `Discord disconnected (side=${side}).`,
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
      return await dispatchDiscordVerify(runtime, service, side, params);
  }
}

async function dispatchDiscordVerify(
  runtime: IAgentRuntime,
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
        channelId: params.sendTarget,
      })
    : [];
  const sendText =
    params.sendMessage ?? "LifeOps Discord connector verification ping.";
  const send =
    (await sendVerificationThroughRegistry({
      runtime,
      connector: "discord",
      target: params.sendTarget,
      text: sendText,
    })) ??
    (params.sendTarget
      ? await service.sendDiscordMessage({
          channelId: params.sendTarget,
          text: sendText,
        })
      : null);
  return {
    success: status.connected && (!params.sendTarget || send?.ok === true),
    text: `Discord verify: status=${status.connected ? "connected" : "disconnected"}, search=${query ? `${hits.length} hit${hits.length === 1 ? "" : "s"}` : "skipped"}, send=${send ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "discord",
      subaction: "verify",
      status,
      search: query ? { ok: true, query, count: hits.length, hits } : null,
      send,
    },
  };
}

async function dispatchIMessage(
  { runtime, service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
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
    case "connect":
      return unsupportedOperation(
        "imessage",
        subaction,
        "iMessage uses the native macOS bridge; nothing to connect via the agent action layer. Inspect status to see bridge readiness.",
      );
    case "disconnect":
      return unsupportedOperation(
        "imessage",
        subaction,
        "iMessage disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return await dispatchIMessageVerify(runtime, service, params);
  }
}

async function dispatchIMessageVerify(
  runtime: IAgentRuntime,
  service: LifeOpsService,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const limit = params.recentLimit ?? 10;
  const [status, messages] = await Promise.all([
    service.getIMessageConnectorStatus(),
    service.readIMessages({ limit }),
  ]);
  const sendText =
    params.sendMessage ?? "LifeOps iMessage connector verification ping.";
  const send =
    (await sendVerificationThroughRegistry({
      runtime,
      connector: "imessage",
      target: params.sendTarget,
      text: sendText,
    })) ??
    (params.sendTarget
      ? await service.sendIMessage({
          to: params.sendTarget,
          text: sendText,
        })
      : null);
  return {
    success: status.connected && (!params.sendTarget || send?.ok === true),
    text: `iMessage verify: status=${status.connected ? "connected" : "disconnected"}, read=${messages.length} message${messages.length === 1 ? "" : "s"}, send=${send ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "imessage",
      subaction: "verify",
      status,
      read: { ok: true, count: messages.length, messages },
      send,
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
    case "connect":
      return unsupportedOperation(
        "whatsapp",
        subaction,
        "WhatsApp connection is managed by @elizaos/plugin-whatsapp. Configure the WhatsApp connector plugin; LifeOps no longer owns local WhatsApp API credentials.",
      );
    case "disconnect":
      return unsupportedOperation(
        "whatsapp",
        subaction,
        "WhatsApp disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return await dispatchWhatsAppVerify(runtime, service, params);
  }
}

async function dispatchWhatsAppVerify(
  runtime: IAgentRuntime,
  service: LifeOpsService,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const limit = params.recentLimit ?? 10;
  const status = await service.getWhatsAppConnectorStatus();
  const recent = await service.pullWhatsAppRecent(limit);
  const sendText =
    params.sendMessage ?? "LifeOps WhatsApp connector verification ping.";
  const send =
    (await sendVerificationThroughRegistry({
      runtime,
      connector: "whatsapp",
      target: params.sendTarget,
      text: sendText,
    })) ??
    (params.sendTarget
      ? await service.sendWhatsAppMessage({
          to: params.sendTarget,
          text: sendText,
        })
      : null);
  return {
    success: status.connected && (!params.sendTarget || send?.ok === true),
    text: `WhatsApp verify: status=${status.connected ? "connected" : "disconnected"}, read=${recent.count} message${recent.count === 1 ? "" : "s"}, send=${send ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "whatsapp",
      subaction: "verify",
      status,
      read: { ok: true, count: recent.count, messages: recent.messages },
      send,
    },
  };
}

async function dispatchBrowserBridge(
  { service }: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  switch (subaction) {
    case "connect": {
      if (!params.browser) {
        return missingParamResult("browser_bridge", subaction, ["browser"]);
      }
      const pairing = await service.createBrowserCompanionPairing({
        browser: params.browser,
        profileId: params.profileId ?? "default",
        profileLabel: params.profileLabel,
      });
      return {
        success: true,
        text: `Browser bridge pairing created. Use pairingToken to finish on the companion (browser=${params.browser}).`,
        data: {
          actionName: ACTION_NAME,
          connector: "browser_bridge",
          subaction,
          pairing,
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
 * {@link dispatchGenericRegistry} which exercises the W1-F contract verbs
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
  health: dispatchHealth,
  browser_bridge: dispatchBrowserBridge,
};

async function dispatchGenericRegistry(
  context: ConnectorDispatchContext,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
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
      const sendResult = params.sendTarget
        ? await contribution.send?.({
            target: params.sendTarget,
            message:
              params.sendMessage ??
              `LifeOps ${contribution.describe.label} verification ping.`,
          })
        : null;
      return {
        success: verified && (!params.sendTarget || sendResult?.ok === true),
        text: `${contribution.describe.label} verify: connected=${verified}, send=${sendResult ? (sendResult.ok ? "ok" : "fail") : "skipped"}.`,
        data: {
          actionName: ACTION_NAME,
          connector: connectorKind,
          subaction,
          verified,
          send: sendResult,
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
    "CONNECT_GOOGLE",
    "CONNECT_TELEGRAM",
    "CONNECT_DISCORD",
    "DISCONNECT_SERVICE",
    "CHECK_CONNECTION",
    "SERVICE_STATUS",
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
    "Manage **account** state for installed connectors: connect (log in), " +
    "disconnect (log out), verify, status, list active accounts. " +
    `Actions: ${VALID_SUBACTIONS.join(", ")}. ` +
    "Targets external service accounts (Google, Telegram, Discord, Slack, etc.). " +
    "Connector kinds resolve through the runtime ConnectorRegistry; verify runs " +
    "an active probe against the upstream API. " +
    "For **plugin** install/uninstall/configure, use the `PLUGIN` action instead.",
  descriptionCompressed:
    "account-level connector lifecycle: connect(log in)|disconnect(log out)|verify|status|list; registry-driven kinds; for plugin install/uninstall use PLUGIN",
  contexts: [
    "connectors",
    "settings",
    "calendar",
    "email",
    "messaging",
    "contacts",
    "health",
    "browser",
  ],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    const merged = mergeParams(message, options);
    if (merged.action === undefined && merged.subaction !== undefined) {
      merged.action = merged.subaction;
    }
    const params = (await extractActionParamsViaLlm<ConnectorActionParams>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: connectorAction.description ?? "",
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
        "Which connector to manage (kind from ConnectorRegistry, e.g. google, x, telegram, signal, discord, imessage, whatsapp, twilio, calendly, duffel, health, browser_bridge). Optional when subaction=list.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "action",
      description:
        "Lifecycle operation. connect (start auth/pairing); disconnect (revoke + clear grant); verify (active read/send probe where available). status/list are read-only diagnostics for explicit troubleshooting; prefer provider/core registry context when available. Strongly preferred - when omitted, the handler runs an LLM extraction over the conversation to recover it.",
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
        "Connection mode: local | cloud_managed | remote. Defaults vary by connector.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["local", "cloud_managed", "remote"],
      },
    },
    {
      name: "recentLimit",
      description:
        "verify only — how many recent messages/dialogs to read where the connector supports passive reads.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "query",
      description:
        "Discord verify only — optional search text to prove browser-message reads.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sendTarget",
      description:
        "verify only — destination chat/recipient/channel for the self-test send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sendMessage",
      description: "verify only — text body for the self-test send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "browser",
      description: "browser_bridge connect only — chrome | safari.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["chrome", "safari"],
      },
    },
    {
      name: "profileId",
      description:
        "browser_bridge connect only — profile identifier within the browser.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "profileLabel",
      description:
        "browser_bridge connect only — human-readable profile label.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "redirectUrl",
      description:
        "google/x connect only — optional OAuth redirect URL override.",
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
          text: "I'll start the plugin-google account OAuth flow and return the auth URL.",
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
