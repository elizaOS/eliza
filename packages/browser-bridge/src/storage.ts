import type { BackgroundState, CompanionConfig } from "./protocol";
import {
  type ExtensionTab,
  queryTabs,
  storageGet,
  storageRemove,
  storageSet,
} from "./webextension";

const CONFIG_KEY = "browserBridgeCompanionConfig";
const STATE_KEY = "browserBridgeBackgroundState";
export const DEFAULT_BROWSER_BRIDGE_API_BASE_URL = "http://127.0.0.1:31337";
const LOOPBACK_DISCOVERY_CANDIDATES = [
  "http://127.0.0.1:2138",
  DEFAULT_BROWSER_BRIDGE_API_BASE_URL,
  "http://localhost:2138",
  "http://localhost:31337",
] as const;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeApiBaseUrl(value: unknown): string | null {
  const trimmed = normalizeString(value).replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_BROWSER_BRIDGE_API_BASE_URL;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function isValidApiBaseUrl(value: unknown): value is string {
  return normalizeApiBaseUrl(value) !== null;
}

function shouldAutofillApiBaseUrl(value: unknown): boolean {
  const trimmed = normalizeString(value).replace(/\/+$/, "");
  return (
    trimmed.length === 0 || trimmed === DEFAULT_BROWSER_BRIDGE_API_BASE_URL
  );
}

function normalizeOriginCandidate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeIsoString(value: unknown): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]"
  );
}

function isLikelyAgentAppTab(tab: ExtensionTab): boolean {
  const haystack = `${tab.title ?? ""} ${tab.url ?? ""}`.toLowerCase();
  return (
    haystack.includes("eliza") ||
    haystack.includes("lifeops")
  );
}

export function candidateApiBaseUrlsFromTabs(
  tabs: readonly ExtensionTab[],
): string[] {
  const likely = new Set<string>();
  const loopback = new Set<string>();

  for (const tab of tabs) {
    const url = normalizeString(tab.url);
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    const origin = parsed.origin.replace(/\/+$/, "");
    if (isLikelyAgentAppTab(tab)) {
      likely.add(origin);
      continue;
    }
    if (isLoopbackHost(parsed.hostname)) {
      loopback.add(origin);
    }
  }

  return [...likely, ...loopback];
}

async function isReachableAgentApiBaseUrl(baseUrl: string): Promise<boolean> {
  const normalized = normalizeOriginCandidate(baseUrl);
  if (!normalized || typeof fetch !== "function") {
    return false;
  }

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller
    ? globalThis.setTimeout(() => controller.abort(), 1500)
    : null;
  try {
    const response = await fetch(`${normalized}/api/status`, {
      method: "GET",
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!payload || typeof payload !== "object") {
      return false;
    }
    return (
      typeof payload.state === "string" ||
      typeof payload.startedAt === "number" ||
      typeof payload.uptime === "number" ||
      typeof payload.pendingRestart === "boolean"
    );
  } catch {
    return false;
  } finally {
    if (timeout !== null) {
      globalThis.clearTimeout(timeout);
    }
  }
}

export async function discoverReachableAgentApiBaseUrls(): Promise<string[]> {
  const tabs = await queryTabs({});
  const candidates = [
    ...candidateApiBaseUrlsFromTabs(tabs),
    ...LOOPBACK_DISCOVERY_CANDIDATES,
  ];
  const seen = new Set<string>();
  const reachable: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeOriginCandidate(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (await isReachableAgentApiBaseUrl(normalized)) {
      reachable.push(normalized);
    }
  }

  return reachable;
}

export async function discoverAgentApiBaseUrl(): Promise<string | null> {
  const reachable = await discoverReachableAgentApiBaseUrls();
  return reachable[0] ?? null;
}

export function normalizeCompanionConfig(
  input: Partial<CompanionConfig> | null | undefined,
): CompanionConfig | null {
  if (!input) {
    return null;
  }
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  if (!apiBaseUrl) {
    return null;
  }
  const companionId = normalizeString(input.companionId);
  const pairingToken = normalizeString(input.pairingToken);
  const browserInput = normalizeString(input.browser);
  const browser =
    browserInput.length === 0
      ? "chrome"
      : browserInput === "safari" || browserInput === "chrome"
        ? browserInput
        : null;
  if (!browser) {
    return null;
  }
  const profileId = normalizeString(input.profileId) || "default";
  const profileLabel = normalizeString(input.profileLabel) || profileId;
  const label =
    normalizeString(input.label) ||
    `Agent Browser Bridge ${browser} ${profileLabel}`;
  if (!companionId || !pairingToken) {
    return null;
  }
  return {
    apiBaseUrl,
    companionId,
    pairingToken,
    pairingTokenExpiresAt: normalizeIsoString(input.pairingTokenExpiresAt),
    browser,
    profileId,
    profileLabel,
    label,
  };
}

export async function loadCompanionConfig(): Promise<CompanionConfig | null> {
  const stored = await storageGet<Partial<CompanionConfig>>(CONFIG_KEY);
  return normalizeCompanionConfig(stored);
}

export async function saveCompanionConfig(
  nextConfig: Partial<CompanionConfig>,
): Promise<CompanionConfig | null> {
  const current = await loadCompanionConfig();
  const merged = {
    ...(current ?? {
      apiBaseUrl: DEFAULT_BROWSER_BRIDGE_API_BASE_URL,
      browser: "chrome",
      profileId: "default",
      profileLabel: "default",
      label: "",
    }),
    ...nextConfig,
  };
  const discoveredApiBaseUrl = shouldAutofillApiBaseUrl(merged.apiBaseUrl)
    ? await discoverAgentApiBaseUrl()
    : null;
  const normalized = normalizeCompanionConfig({
    ...merged,
    apiBaseUrl: discoveredApiBaseUrl ?? merged.apiBaseUrl,
  });
  if (!normalized) {
    return null;
  }
  await storageSet({ [CONFIG_KEY]: normalized });
  return normalized;
}

export async function clearCompanionConfig(): Promise<void> {
  await storageRemove(CONFIG_KEY);
}

export async function loadBackgroundState(): Promise<BackgroundState | null> {
  return await storageGet<BackgroundState>(STATE_KEY);
}

export async function saveBackgroundState(
  state: BackgroundState,
): Promise<void> {
  await storageSet({ [STATE_KEY]: state });
}
