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
import { extractActionParamsViaLlm } from "@elizaos/agent";
import { hasLifeOpsAccess, INTERNAL_URL } from "./lifeops-google-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectorKind =
  | "google"
  | "x"
  | "telegram"
  | "signal"
  | "discord"
  | "imessage"
  | "whatsapp"
  | "browser_bridge";

type ConnectorSubaction =
  | "connect"
  | "disconnect"
  | "verify"
  | "status"
  | "list";

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
  sendTarget?: string;
  sendMessage?: string;
  browser?: "chrome" | "safari";
  profileId?: string;
  profileLabel?: string;
  redirectUrl?: string;
  capabilities?: string[];
};

const ACTION_NAME = "LIFEOPS_CONNECTOR";

const VALID_CONNECTORS: readonly ConnectorKind[] = [
  "google",
  "x",
  "telegram",
  "signal",
  "discord",
  "imessage",
  "whatsapp",
  "browser_bridge",
];

const VALID_SUBACTIONS: readonly ConnectorSubaction[] = [
  "connect",
  "disconnect",
  "verify",
  "status",
  "list",
];

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

function notImplemented(
  connector: ConnectorKind,
  subaction: ConnectorSubaction,
  detail?: string,
): ActionResult {
  const text =
    `[${ACTION_NAME}] ${connector}/${subaction} is not yet implemented in the agent action layer.` +
    (detail ? ` ${detail}` : "");
  return {
    success: false,
    text,
    data: {
      actionName: ACTION_NAME,
      connector,
      subaction,
      error: "NOT_IMPLEMENTED",
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

async function dispatchListAll(
  service: LifeOpsService,
): Promise<ActionResult> {
  const [
    google,
    x,
    telegram,
    signal,
    discord,
    imessage,
    whatsapp,
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
    service.getBrowserSettings(),
    service.listBrowserCompanions(),
  ]);
  return {
    success: true,
    text: "Listed status for all 8 LifeOps connectors.",
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
        browser_bridge: { settings: browserSettings, companions: browserCompanions },
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
        data: { actionName: ACTION_NAME, connector: "google", subaction, response },
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
        data: { actionName: ACTION_NAME, connector: "google", subaction, status },
      };
    }
    case "status": {
      const status = await service.getGoogleConnectorStatus(
        INTERNAL_URL,
        params.mode,
        side,
      );
      return {
        success: true,
        text: `Google connector status retrieved (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "google", subaction, status },
      };
    }
    case "verify":
      return notImplemented(
        "google",
        subaction,
        "Google verify subaction is not exposed by LifeOpsService. Use status to inspect grant freshness.",
      );
    case "list":
      return notImplemented(
        "google",
        subaction,
        "Per-connector list is not separate from status; use subaction=list with no connector to see all connectors.",
      );
  }
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
    case "status": {
      const status = await service.getXConnectorStatus(params.mode, side);
      return {
        success: true,
        text: `X connector status retrieved (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "x", subaction, status },
      };
    }
    case "verify":
      return notImplemented("x", subaction);
    case "list":
      return notImplemented("x", subaction);
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
        data: { actionName: ACTION_NAME, connector: "telegram", subaction, response },
      };
    }
    case "disconnect": {
      const status = await service.disconnectTelegram(side);
      return {
        success: true,
        text: `Telegram disconnected (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "telegram", subaction, status },
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
        success: response.read.ok && (params.sendTarget ? response.send.ok : true),
        text: `Telegram verify: read=${response.read.ok ? "ok" : "fail"}, send=${response.send.ok ? "ok" : "fail"}.`,
        data: { actionName: ACTION_NAME, connector: "telegram", subaction, response },
      };
    }
    case "status": {
      const status = await service.getTelegramConnectorStatus(side);
      return {
        success: true,
        text: `Telegram connector status retrieved (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "telegram", subaction, status },
      };
    }
    case "list":
      return notImplemented("telegram", subaction);
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
        data: { actionName: ACTION_NAME, connector: "signal", subaction, response },
      };
    }
    case "disconnect": {
      const status = await service.disconnectSignal(side);
      return {
        success: true,
        text: `Signal disconnected (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "signal", subaction, status },
      };
    }
    case "status": {
      const status = await service.getSignalConnectorStatus(side);
      return {
        success: true,
        text: `Signal connector status retrieved (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "signal", subaction, status },
      };
    }
    case "verify":
      return notImplemented("signal", subaction);
    case "list":
      return notImplemented("signal", subaction);
  }
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
        data: { actionName: ACTION_NAME, connector: "discord", subaction, status },
      };
    }
    case "disconnect": {
      const status = await service.disconnectDiscord(side);
      return {
        success: true,
        text: `Discord disconnected (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "discord", subaction, status },
      };
    }
    case "status": {
      const status = await service.getDiscordConnectorStatus(side);
      return {
        success: true,
        text: `Discord connector status retrieved (side=${side}).`,
        data: { actionName: ACTION_NAME, connector: "discord", subaction, status },
      };
    }
    case "verify":
      return notImplemented("discord", subaction);
    case "list":
      return notImplemented("discord", subaction);
  }
}

async function dispatchIMessage(
  service: LifeOpsService,
  subaction: ConnectorSubaction,
): Promise<ActionResult> {
  switch (subaction) {
    case "status": {
      const status = await service.getIMessageConnectorStatus();
      return {
        success: true,
        text: `iMessage connector status retrieved.`,
        data: { actionName: ACTION_NAME, connector: "imessage", subaction, status },
      };
    }
    case "connect":
      return notImplemented(
        "imessage",
        subaction,
        "iMessage uses the native macOS bridge; nothing to connect via the agent action layer. Inspect status to see bridge readiness.",
      );
    case "disconnect":
      return notImplemented(
        "imessage",
        subaction,
        "iMessage disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return notImplemented("imessage", subaction);
    case "list":
      return notImplemented("imessage", subaction);
  }
}

async function dispatchWhatsApp(
  service: LifeOpsService,
  subaction: ConnectorSubaction,
): Promise<ActionResult> {
  switch (subaction) {
    case "status": {
      const status = await service.getWhatsAppConnectorStatus();
      return {
        success: true,
        text: `WhatsApp connector status retrieved.`,
        data: { actionName: ACTION_NAME, connector: "whatsapp", subaction, status },
      };
    }
    case "connect":
      return notImplemented(
        "whatsapp",
        subaction,
        "WhatsApp connection is configured via env vars (ELIZA_WHATSAPP_ACCESS_TOKEN / ELIZA_WHATSAPP_PHONE_NUMBER_ID); nothing to do via the action layer.",
      );
    case "disconnect":
      return notImplemented(
        "whatsapp",
        subaction,
        "WhatsApp disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return notImplemented("whatsapp", subaction);
    case "list":
      return notImplemented("whatsapp", subaction);
  }
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
      return notImplemented(
        "browser_bridge",
        subaction,
        "Browser companion disconnect is not exposed by LifeOpsService.",
      );
    case "verify":
      return notImplemented("browser_bridge", subaction);
  }
}

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
    "Connectors: google | x | telegram | signal | discord | imessage | whatsapp | browser_bridge. " +
    "Subactions: connect (start auth/pairing), disconnect (revoke and clear grant), verify (active health probe — Telegram only today), status (per-connector grant/health), list (status across all 8 connectors when no connector is set). " +
    "Examples: connect Google for the owner; disconnect Telegram; check Discord status; verify Telegram by sending a self-test; list all connectors. " +
    "When subaction=list and no connector is set, returns status for every connector in one call. " +
    "Connector-specific params: telegram connect needs phone (+ optional apiId/apiHash); browser_bridge connect needs browser (chrome/safari/...). " +
    "Admin / private access only.",
  descriptionCompressed:
    "LifeOps connectors lifecycle: connect/disconnect/verify/status/list across google, x, telegram, signal, discord, imessage, whatsapp, browser_bridge.",
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
      switch (connector) {
        case "google":
          return await dispatchGoogle(service, subaction, params);
        case "x":
          return await dispatchX(service, subaction, params);
        case "telegram":
          return await dispatchTelegram(service, subaction, params);
        case "signal":
          return await dispatchSignal(service, subaction, params);
        case "discord":
          return await dispatchDiscord(service, subaction, params);
        case "imessage":
          return await dispatchIMessage(service, subaction);
        case "whatsapp":
          return await dispatchWhatsApp(service, subaction);
        case "browser_bridge":
          return await dispatchBrowserBridge(service, subaction, params);
      }
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
        "Which connector to manage. One of: google, x, telegram, signal, discord, imessage, whatsapp, browser_bridge. Optional when subaction=list.",
      required: false,
      schema: { type: "string" as const, enum: [...VALID_CONNECTORS] },
    },
    {
      name: "subaction",
      description:
        "Lifecycle operation. connect (start auth/pairing); disconnect (revoke + clear grant); verify (health probe, Telegram only); status (per-connector status); list (cross-connector status when connector is omitted).",
      required: true,
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
      description: "Telegram connect only — full phone number with country code.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "apiId",
      description:
        "Telegram connect only — optional Telegram apiId override.",
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
      description: "Telegram verify only — how many recent dialogs to probe.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "sendTarget",
      description:
        "Telegram verify only — destination chat for the self-test send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sendMessage",
      description:
        "Telegram verify only — text body for the self-test send.",
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
