/** Local browser handoff preferences only; provider credentials never enter this store. */
import { ElizaError } from "@elizaos/shared/browser-contracts";
import { getStorageValue, setStorageValue } from "../bridge/storage-bridge";

export type PasswordProvider = "bitwarden" | "1password";
export interface PasswordProviderSettings {
  provider: PasswordProvider;
  webVaults: Record<PasswordProvider, string>;
}

const STORAGE_KEY = "eliza.browser.password-provider.v1";

export function defaultPasswordProviderSettings(): PasswordProviderSettings {
  return {
    provider: "bitwarden",
    webVaults: {
      bitwarden: "https://vault.bitwarden.com/",
      "1password": "https://my.1password.com/",
    },
  };
}

export function validatePasswordProviderUrl(
  provider: PasswordProvider,
  value: string,
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    // error-policy:J3 Reject malformed destinations before browser dispatch.
    throw new ElizaError("Enter a complete HTTPS web vault address.", {
      code: "PASSWORD_PROVIDER_URL_INVALID",
      cause,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ElizaError(
      "Use HTTPS without a username, password, query, or fragment.",
      { code: "PASSWORD_PROVIDER_URL_INVALID" },
    );
  }
  if (
    provider === "1password" &&
    (!/^[a-z0-9-]+\.1password\.(com|eu|ca)$/.test(url.hostname) ||
      (url.port && url.port !== "443"))
  ) {
    throw new ElizaError(
      "Use your account address on 1password.com, 1password.eu, or 1password.ca.",
      { code: "PASSWORD_PROVIDER_URL_INVALID" },
    );
  }
  return url.href;
}

function parseSettings(value: unknown): PasswordProviderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElizaError("Saved password provider settings are invalid.", {
      code: "PASSWORD_PROVIDER_SETTINGS_INVALID",
    });
  }
  const record = value as Record<string, unknown>;
  const urls = record.webVaults;
  if (
    (record.provider !== "bitwarden" && record.provider !== "1password") ||
    !urls ||
    typeof urls !== "object" ||
    Array.isArray(urls) ||
    typeof (urls as Record<string, unknown>).bitwarden !== "string" ||
    typeof (urls as Record<string, unknown>)["1password"] !== "string"
  ) {
    throw new ElizaError("Saved password provider settings are invalid.", {
      code: "PASSWORD_PROVIDER_SETTINGS_INVALID",
    });
  }
  const webVaults = urls as Record<PasswordProvider, string>;
  return {
    provider: record.provider,
    webVaults: {
      bitwarden: validatePasswordProviderUrl("bitwarden", webVaults.bitwarden),
      "1password": validatePasswordProviderUrl(
        "1password",
        webVaults["1password"],
      ),
    },
  };
}

export async function loadPasswordProviderSettings(): Promise<PasswordProviderSettings> {
  const stored = await getStorageValue(STORAGE_KEY);
  if (stored === null) return defaultPasswordProviderSettings();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (cause) {
    // error-policy:J3 Malformed persisted destinations require an explicit reset.
    throw new ElizaError("Saved password provider settings are invalid.", {
      code: "PASSWORD_PROVIDER_SETTINGS_INVALID",
      cause,
    });
  }
  return parseSettings(parsed);
}

export async function savePasswordProviderSettings(
  settings: PasswordProviderSettings,
): Promise<void> {
  await setStorageValue(STORAGE_KEY, JSON.stringify(parseSettings(settings)));
}
