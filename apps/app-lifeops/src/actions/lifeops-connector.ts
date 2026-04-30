import { extractActionParamsViaLlm } from "@elizaos/agent/actions/extract-params";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { hasLifeOpsAccess, INTERNAL_URL } from "./lifeops-google-helpers.js";

const ACTION_NAME = "LIFEOPS_CONNECTOR";

const VALID_CONNECTORS = [
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

type ConnectorKind = (typeof VALID_CONNECTORS)[number];
type ConnectorSubaction = (typeof VALID_SUBACTIONS)[number];

type ConnectorActionParams = {
  connector?: ConnectorKind;
  subaction?: ConnectorSubaction;
  side?: "owner" | "agent";
  mode?: "local" | "cloud_managed" | "remote";
  // Connector-specific params (passed through to underlying service methods).
  phone?: string;
  apiId?: number;
  apiHash?: string;
  recentLimit?: number;
  query?: string;
  sendTarget?: string;
  sendMessage?: string;
  browser?: "chrome" | "safari";
  profileId?: string;
  profileLabel?: string;
  redirectUrl?: string;
  capabilities?: string[];
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
  service: LifeOpsService,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
) => Promise<ActionResult>;

function normalizeConnector(value: unknown): ConnectorKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[- ]/g, "_");
  return (VALID_CONNECTORS as readonly string[]).includes(normalized)
    ? (normalized as ConnectorKind)
    : null;
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
  connector: ConnectorKind,
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
  connector: ConnectorKind,
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

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchListAll(service: LifeOpsService): Promise<ActionResult> {
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
    service.getXConnectorStatus(),
    service.getTelegramConnectorStatus(),
    service.getSignalConnectorStatus(),
    service.getDiscordConnectorStatus(),
    service.getIMessageConnectorStatus(),
    service.getWhatsAppConnectorStatus(),
    service.getHealthDataConnectorStatuses(INTERNAL_URL),
    service.getBrowserSettings(),
    service.listBrowserCompanions(),
  ]);
  return {
    success: true,
    text: `Listed status for all ${VALID_CONNECTORS.length} LifeOps connectors.`,
    data: {
      actionName: ACTION_NAME,
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
  service: LifeOpsService,
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
  service: LifeOpsService,
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
  const send = params.sendTarget
    ? await service.sendXDirectMessage({
        participantId: params.sendTarget,
        text: params.sendMessage ?? "LifeOps X connector verification ping.",
        mode: params.mode,
        side,
        confirmSend: true,
      })
    : null;
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
  service: LifeOpsService,
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
  service: LifeOpsService,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      if (!params.phone) {
        return missingParamResult("telegram", subaction, ["phone"]);
      }
      const response = await service.startTelegramAuth({
        side,
        phone: params.phone,
        apiId: params.apiId,
        apiHash: params.apiHash,
      });
      return {
        success: true,
        text: `Telegram auth started (state=${response.state}). Submit the SMS code to finish connecting.`,
        data: {
          actionName: ACTION_NAME,
          connector: "telegram",
          subaction,
          response,
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
      const response = await service.verifyTelegramConnector({
        side,
        recentLimit: params.recentLimit,
        sendTarget: params.sendTarget,
        sendMessage: params.sendMessage,
      });
      return {
        success: response.read.ok && response.send.ok,
        text: `Telegram verify: read=${response.read.ok ? "ok" : "fail"}, send=${response.send.ok ? "ok" : "fail"}.`,
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
  service: LifeOpsService,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      const response = await service.startSignalPairing(side);
      return {
        success: true,
        text: `Signal pairing started (sessionId=${response.sessionId}). Scan the QR code from Signal mobile to link.`,
        data: {
          actionName: ACTION_NAME,
          connector: "signal",
          subaction,
          response,
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
  const [status, messages] = await Promise.all([
    service.getSignalConnectorStatus(side),
    service.readSignalInbound(limit),
  ]);
  const send = params.sendTarget
    ? await service.sendSignalMessage({
        recipient: params.sendTarget,
        text:
          params.sendMessage ?? "LifeOps Signal connector verification ping.",
      })
    : null;
  return {
    success: status.connected && (!params.sendTarget || send?.ok === true),
    text: `Signal verify: status=${status.connected ? "connected" : "disconnected"}, read=${messages.length} message${messages.length === 1 ? "" : "s"}, send=${send ? "ok" : "skipped"}.`,
    data: {
      actionName: ACTION_NAME,
      connector: "signal",
      subaction: "verify",
      status,
      read: { ok: true, count: messages.length, messages },
      send,
    },
  };
}

async function dispatchDiscord(
  service: LifeOpsService,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  const side = normalizeSide(params.side) ?? "owner";
  switch (subaction) {
    case "connect": {
      const status = await service.authorizeDiscordConnector(side);
      return {
        success: true,
        text: `Discord browser connector authorized (side=${side}).`,
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
        channelId: params.sendTarget,
      })
    : [];
  const send = params.sendTarget
    ? await service.sendDiscordMessage({
        channelId: params.sendTarget,
        text:
          params.sendMessage ?? "LifeOps Discord connector verification ping.",
      })
    : null;
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
  service: LifeOpsService,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  switch (subaction) {
    case "status":
    case "list": {
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
  const send = params.sendTarget
    ? await service.sendIMessage({
        to: params.sendTarget,
        text:
          params.sendMessage ?? "LifeOps iMessage connector verification ping.",
      })
    : null;
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
  service: LifeOpsService,
  subaction: ConnectorSubaction,
  params: ConnectorActionParams,
): Promise<ActionResult> {
  switch (subaction) {
    case "status":
    case "list": {
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
        "WhatsApp connection is configured via env vars (ELIZA_WHATSAPP_ACCESS_TOKEN / ELIZA_WHATSAPP_PHONE_NUMBER_ID); nothing to do via the action layer.",
      );
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
  const recent = service.pullWhatsAppRecent(limit);
  const send = params.sendTarget
    ? await service.sendWhatsAppMessage({
        to: params.sendTarget,
        text:
          params.sendMessage ?? "LifeOps WhatsApp connector verification ping.",
      })
    : null;
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
  service: LifeOpsService,
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

const CONNECTOR_DISPATCHERS = {
  google: dispatchGoogle,
  x: dispatchX,
  telegram: dispatchTelegram,
  signal: dispatchSignal,
  discord: dispatchDiscord,
  imessage: dispatchIMessage,
  whatsapp: dispatchWhatsApp,
  health: dispatchHealth,
  browser_bridge: dispatchBrowserBridge,
} satisfies Record<ConnectorKind, ConnectorDispatcher>;

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const lifeOpsConnectorAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "MANAGE_LIFEOPS_CONNECTORS",
    "LIFEOPS_CONNECT",
    "LIFEOPS_DISCONNECT",
    "CONNECT_GOOGLE",
    "CONNECT_TELEGRAM",
    "CONNECT_DISCORD",
    "CONNECT_SIGNAL",
    "CONNECT_X",
    "CONNECT_BROWSER_BRIDGE",
    "DISCONNECT_GOOGLE",
    "DISCONNECT_TELEGRAM",
    "DISCONNECT_DISCORD",
    "DISCONNECT_SIGNAL",
    "DISCONNECT_X",
    "CONNECTOR_STATUS",
    "LIST_CONNECTORS",
  ],
  description:
    "Manage the lifecycle of every LifeOps connector. " +
    `Connectors: ${VALID_CONNECTORS.join(" | ")}. ` +
    `Subactions: ${VALID_SUBACTIONS.join(" | ")}. connect (start auth/pairing), disconnect (revoke and clear grant), verify (active read/send probe where the connector exposes one), status (per-connector grant/health), list (status across all ${VALID_CONNECTORS.length} connectors when no connector is set). ` +
    "Examples: connect Google for the owner; disconnect Telegram; check Discord status; verify Telegram by sending a self-test; list all connectors. " +
    "When subaction=list and no connector is set, returns status for every connector in one call. " +
    "Connector-specific params: telegram connect needs phone (+ optional apiId/apiHash); browser_bridge connect needs browser (chrome/safari/...). " +
    "Owner access only.",
  descriptionCompressed:
    "LifeOps connectors lifecycle: connect/disconnect/verify/status/list across google, x, telegram, signal, discord, imessage, whatsapp, health, browser_bridge.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory) =>
    hasLifeOpsAccess(runtime, message),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    const merged = mergeParams(message, options);
    const params = (await extractActionParamsViaLlm<ConnectorActionParams>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: lifeOpsConnectorAction.description ?? "",
      paramSchema: lifeOpsConnectorAction.parameters ?? [],
      existingParams: merged,
      requiredFields: ["subaction"],
    })) as ConnectorActionParams;
    const subaction = normalizeSubaction(params.subaction);
    if (!subaction) {
      return {
        success: false,
        text: `[${ACTION_NAME}] missing subaction; choose one of ${VALID_SUBACTIONS.join(" | ")}.`,
        data: {
          actionName: ACTION_NAME,
          error: "MISSING_SUBACTION",
          validSubactions: VALID_SUBACTIONS,
        },
      };
    }

    const service = new LifeOpsService(runtime);

    // `list` with no connector means "list all connectors".
    const connector = normalizeConnector(params.connector);
    if (subaction === "list" && !connector) {
      try {
        return await dispatchListAll(service);
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

    if (!connector) {
      return {
        success: false,
        text: `[${ACTION_NAME}] missing connector; choose one of ${VALID_CONNECTORS.join(" | ")}.`,
        data: {
          actionName: ACTION_NAME,
          error: "MISSING_CONNECTOR",
          validConnectors: VALID_CONNECTORS,
        },
      };
    }

    try {
      return await CONNECTOR_DISPATCHERS[connector](service, subaction, params);
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
        "Which connector to manage. One of: google, x, telegram, signal, discord, imessage, whatsapp, health, browser_bridge. Optional when subaction=list.",
      required: false,
      schema: { type: "string" as const, enum: [...VALID_CONNECTORS] },
    },
    {
      name: "subaction",
      description:
        "Lifecycle operation. connect (start auth/pairing); disconnect (revoke + clear grant); verify (active read/send probe where available); status (per-connector status); list (cross-connector status when connector is omitted). Strongly preferred — when omitted, the handler runs an LLM extraction over the conversation to recover it.",
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
      name: "phone",
      description:
        "Telegram connect only — full phone number with country code.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "apiId",
      description: "Telegram connect only — optional Telegram apiId override.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "apiHash",
      description:
        "Telegram connect only — optional Telegram apiHash override.",
      required: false,
      schema: { type: "string" as const },
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
          text: "I'll start the Google OAuth flow and return the auth URL.",
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
