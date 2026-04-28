import type {
  CloudBillingCheckoutResponse,
  CloudBillingSettings,
  CloudBillingSummary,
  CloudCompatAgent,
} from "../../api";
import { pathForTab } from "../../navigation";
import { isCloudStatusReasonApiKeyOnly } from "../../utils/cloud-status";

export const ELIZA_CLOUD_INSTANCES_URL =
  "https://www.elizacloud.ai/dashboard/app";
/** Marketing / docs site — "Learn more" when not connected (in-app browser on desktop). */
export const ELIZA_CLOUD_WEB_URL = "https://elizacloud.ai";
export const BILLING_PRESET_AMOUNTS = [10, 25, 100];
export const MANAGED_DISCORD_GATEWAY_AGENT_NAME = "Discord Gateway";

export const STATUS_BADGE: Record<
  string,
  { i18nKey: string; className: string }
> = {
  running: {
    i18nKey: "appsview.Running",
    className: "bg-ok/10 text-ok border-ok/20",
  },
  queued: {
    i18nKey: "common.queued",
    className: "bg-warn/10 text-warn border-warn/20",
  },
  provisioning: {
    i18nKey: "elizaclouddashboard.statusProvisioning",
    className: "bg-accent/10 text-txt border-accent/20",
  },
  stopped: {
    i18nKey: "elizaclouddashboard.statusStopped",
    className: "bg-muted/10 text-muted border-border/40",
  },
  failed: {
    i18nKey: "heartbeatsview.statusFailed",
    className: "bg-danger/10 text-danger border-danger/20",
  },
};

export function getCloudAuthToken(): string {
  if (typeof window === "undefined") return "";
  return (
    ((globalThis as Record<string, unknown>)
      .__ELIZA_CLOUD_AUTH_TOKEN__ as string) || ""
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveCloudAccountIdDisplay(
  userId: string | null,
  statusReason: string | null,
  t: (key: string) => string,
): { mono: boolean; text: string } {
  if (userId) {
    return { mono: true, text: userId };
  }
  if (isCloudStatusReasonApiKeyOnly(statusReason)) {
    return { mono: false, text: t("elizaclouddashboard.AccountIdApiKeyOnly") };
  }
  return {
    mono: false,
    text: t("elizaclouddashboard.AccountIdSessionNoUserId"),
  };
}

export function unwrapBillingData<T extends Record<string, unknown>>(
  value: T,
): T {
  if (isRecord(value.data)) {
    return value.data as T;
  }
  return value;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export interface ManagedDiscordCallbackState {
  status: "connected" | "error";
  agentId: string | null;
  guildId: string | null;
  guildName: string | null;
  managed: boolean;
  message: string | null;
  restarted: boolean;
}

const MANAGED_DISCORD_CALLBACK_QUERY_KEYS = [
  "discord",
  "managed",
  "agentId",
  "guildId",
  "guildName",
  "restarted",
  "message",
] as const;

export function consumeManagedDiscordCallbackUrl(rawUrl: string): {
  callback: ManagedDiscordCallbackState | null;
  cleanedUrl: string | null;
} {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { callback: null, cleanedUrl: null };
  }

  const status = url.searchParams.get("discord");
  const managed = url.searchParams.get("managed") === "1";
  if ((status !== "connected" && status !== "error") || !managed) {
    return { callback: null, cleanedUrl: null };
  }

  const callback: ManagedDiscordCallbackState = {
    status,
    managed,
    agentId: readString(url.searchParams.get("agentId")) ?? null,
    guildId: readString(url.searchParams.get("guildId")) ?? null,
    guildName: readString(url.searchParams.get("guildName")) ?? null,
    message: readString(url.searchParams.get("message")) ?? null,
    restarted: url.searchParams.get("restarted") === "1",
  };

  for (const key of MANAGED_DISCORD_CALLBACK_QUERY_KEYS) {
    url.searchParams.delete(key);
  }

  return {
    callback,
    cleanedUrl: url.toString(),
  };
}

export function buildManagedDiscordSettingsReturnUrl(
  rawUrl: string,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const settingsPath = pathForTab("settings");

  if (url.protocol === "file:") {
    url.hash = settingsPath;
    url.search = "";
    return url.toString();
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  const settingsPathname = normalizedPath.replace(/\/[^/]*$/, settingsPath);
  url.pathname = settingsPathname === "" ? settingsPath : settingsPathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveManagedDiscordAgentChoice(agents: CloudCompatAgent[]):
  | {
      mode: "none";
      agent: null;
      selectedAgentId: null;
    }
  | {
      mode: "bootstrap";
      agent: null;
      selectedAgentId: null;
    }
  | {
      mode: "direct";
      agent: CloudCompatAgent;
      selectedAgentId: string;
    }
  | {
      mode: "picker";
      agent: null;
      selectedAgentId: string;
    } {
  const gatewayAgents = agents.filter(isManagedDiscordGatewayAgent);
  if (agents.length === 0) {
    return {
      mode: "none",
      agent: null,
      selectedAgentId: null,
    };
  }

  if (gatewayAgents.length === 0) {
    return {
      mode: "bootstrap",
      agent: null,
      selectedAgentId: null,
    };
  }

  if (gatewayAgents.length === 1) {
    return {
      mode: "direct",
      agent: gatewayAgents[0],
      selectedAgentId: gatewayAgents[0].agent_id,
    };
  }

  return {
    mode: "picker",
    agent: null,
    selectedAgentId: (gatewayAgents[0] ?? agents[0]).agent_id,
  };
}

export function isManagedDiscordGatewayAgent(agent: CloudCompatAgent): boolean {
  const config = isRecord(agent.agent_config) ? agent.agent_config : null;
  const gatewayConfig = config
    ? (config.__managedDiscordGateway as Record<string, unknown> | undefined)
    : undefined;
  if (isRecord(gatewayConfig) && gatewayConfig.mode === "shared-gateway") {
    return true;
  }

  return (
    agent.agent_name.trim().toLowerCase() ===
    MANAGED_DISCORD_GATEWAY_AGENT_NAME.toLowerCase()
  );
}

export interface ManagedGithubCallbackState {
  status: "connected" | "error";
  connectionId: string | null;
  agentId: string | null;
  message: string | null;
}

const MANAGED_GITHUB_CALLBACK_QUERY_KEYS = [
  "github_connected",
  "connection_id",
  "platform",
  "managed_github_agent",
  "github_error",
] as const;

export function consumeManagedGithubCallbackUrl(rawUrl: string): {
  callback: ManagedGithubCallbackState | null;
  cleanedUrl: string | null;
} {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { callback: null, cleanedUrl: null };
  }

  const connected = url.searchParams.get("github_connected") === "true";
  const error = url.searchParams.get("github_error");
  const agentId =
    readString(url.searchParams.get("managed_github_agent")) ?? null;

  if (!connected && !error) {
    return { callback: null, cleanedUrl: null };
  }

  const callback: ManagedGithubCallbackState = {
    status: connected ? "connected" : "error",
    connectionId: readString(url.searchParams.get("connection_id")) ?? null,
    agentId,
    message: error ? decodeURIComponent(error) : null,
  };

  for (const key of MANAGED_GITHUB_CALLBACK_QUERY_KEYS) {
    url.searchParams.delete(key);
  }

  return {
    callback,
    cleanedUrl: url.toString(),
  };
}

export function normalizeBillingSummary(
  raw: CloudBillingSummary,
): CloudBillingSummary {
  const source = unwrapBillingData(raw);
  return {
    ...raw,
    ...source,
    balance:
      readNumber(source.balance) ??
      readNumber((source as Record<string, unknown>).creditBalance) ??
      null,
    currency:
      readString(source.currency) ??
      readString((source as Record<string, unknown>).balanceCurrency),
    topUpUrl:
      readString(source.topUpUrl) ??
      readString((source as Record<string, unknown>).billingUrl),
    embeddedCheckoutEnabled:
      readBoolean(source.embeddedCheckoutEnabled) ??
      readBoolean((source as Record<string, unknown>).embedded),
    hostedCheckoutEnabled:
      readBoolean(source.hostedCheckoutEnabled) ??
      readBoolean((source as Record<string, unknown>).hosted),
    cryptoEnabled:
      readBoolean(source.cryptoEnabled) ??
      readBoolean((source as Record<string, unknown>).crypto),
    low: readBoolean(source.low),
    critical: readBoolean(source.critical),
  };
}

export function normalizeBillingSettings(
  raw: CloudBillingSettings,
): CloudBillingSettings {
  const source = unwrapBillingData(raw);
  return {
    ...raw,
    ...source,
    settings: isRecord(source.settings) ? source.settings : raw.settings,
  };
}

export function getBillingAutoTopUp(
  settings: CloudBillingSettings | null,
): Record<string, unknown> {
  const rawSettings = isRecord(settings?.settings) ? settings.settings : null;
  return isRecord(rawSettings?.autoTopUp) ? rawSettings.autoTopUp : {};
}

export function getBillingLimits(
  settings: CloudBillingSettings | null,
): Record<string, unknown> {
  const rawSettings = isRecord(settings?.settings) ? settings.settings : null;
  return isRecord(rawSettings?.limits) ? rawSettings.limits : {};
}

export function resolveCheckoutUrl(
  response: CloudBillingCheckoutResponse,
): string | null {
  return (
    readString(response.checkoutUrl) ??
    readString(response.url) ??
    readString((response as Record<string, unknown>).hostedUrl) ??
    null
  );
}

export interface AutoTopUpFormState {
  amount: string;
  dirty: boolean;
  enabled: boolean;
  sourceKey: string;
  threshold: string;
}

export type AutoTopUpFormAction =
  | { type: "hydrate"; next: AutoTopUpFormState; force?: boolean }
  | { type: "setAmount"; value: string }
  | { type: "setEnabled"; value: boolean }
  | { type: "setThreshold"; value: string };

export function buildAutoTopUpFormState(
  billingSummary: CloudBillingSummary | null,
  billingSettings: CloudBillingSettings | null,
): AutoTopUpFormState {
  const autoTopUp = getBillingAutoTopUp(billingSettings);
  const minimumTopUp =
    readNumber(
      (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
    ) ?? 1;
  const enabled = readBoolean(autoTopUp.enabled) ?? false;
  const amount = String(readNumber(autoTopUp.amount) ?? minimumTopUp);
  const threshold = String(readNumber(autoTopUp.threshold) ?? 5);
  return {
    amount,
    dirty: false,
    enabled,
    sourceKey: JSON.stringify([enabled, amount, threshold]),
    threshold,
  };
}

export function autoTopUpFormReducer(
  state: AutoTopUpFormState,
  action: AutoTopUpFormAction,
): AutoTopUpFormState {
  switch (action.type) {
    case "hydrate":
      if (!action.force && state.dirty) {
        return state;
      }
      if (state.sourceKey === action.next.sourceKey && !state.dirty) {
        return state;
      }
      return action.next;
    case "setAmount":
      return { ...state, amount: action.value, dirty: true };
    case "setEnabled":
      return { ...state, enabled: action.value, dirty: true };
    case "setThreshold":
      return { ...state, threshold: action.value, dirty: true };
    default:
      return state;
  }
}
