import type { BackgroundState, CompanionConfig } from "./protocol";
import { storageGet, storageRemove, storageSet } from "./webextension";

const CONFIG_KEY = "lifeopsBrowserCompanionConfig";
const STATE_KEY = "lifeopsBrowserBackgroundState";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeApiBaseUrl(value: unknown): string {
  const trimmed = normalizeString(value).replace(/\/+$/, "");
  return trimmed || "http://127.0.0.1:31337";
}

export function normalizeCompanionConfig(
  input: Partial<CompanionConfig> | null | undefined,
): CompanionConfig | null {
  if (!input) {
    return null;
  }
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const companionId = normalizeString(input.companionId);
  const pairingToken = normalizeString(input.pairingToken);
  const browser =
    normalizeString(input.browser) === "safari" ? "safari" : "chrome";
  const profileId = normalizeString(input.profileId) || "default";
  const profileLabel = normalizeString(input.profileLabel) || profileId;
  const label =
    normalizeString(input.label) ||
    `LifeOps Browser ${browser} ${profileLabel}`;
  if (!companionId || !pairingToken) {
    return null;
  }
  return {
    apiBaseUrl,
    companionId,
    pairingToken,
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
  const normalized = normalizeCompanionConfig({
    ...(current ?? {
      apiBaseUrl: "http://127.0.0.1:31337",
      browser: "chrome",
      profileId: "default",
      profileLabel: "default",
      label: "",
    }),
    ...nextConfig,
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
