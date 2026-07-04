/**
 * Accessors for the `window`-scoped elizaOS globals (`__ELIZAOS_API_BASE__`, API
 * token) that the injected renderer environment sets. Resolves the API base/token
 * from the window or the boot-config store, returning null when off-browser.
 */
import { getBootConfig, setBootConfig } from "../config/boot-config-store.js";

export type ElizaWindow = Window & {
  __ELIZAOS_API_BASE__?: string;
};

function getElizaWindow(): ElizaWindow | null {
  return typeof window === "undefined" ? null : (window as ElizaWindow);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// The boot config is the single source of truth for the API base (see
// boot-config-store.ts). Reading it here — rather than a bespoke API-base window
// global — gives every transport and web shim one accessor with one precedence
// rule. The agent static-file server and the Electrobun renderer seed the
// boot-config `apiBase` into the HTML before any app JS runs.
export function getElizaApiBase(): string | undefined {
  return readTrimmedString(getBootConfig().apiBase);
}

export function getElizaApiToken(): string | undefined {
  return readTrimmedString(getBootConfig().apiToken);
}

export function setElizaApiBase(value: string): void {
  const apiBase = readTrimmedString(value);
  setBootConfig({ ...getBootConfig(), apiBase });

  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    if (apiBase) {
      elizaWindow.__ELIZAOS_API_BASE__ = apiBase;
    } else {
      Reflect.deleteProperty(elizaWindow, "__ELIZAOS_API_BASE__");
    }
  }
}

export function clearElizaApiBase(): void {
  const { apiBase: _apiBase, ...config } = getBootConfig();
  setBootConfig(config);

  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    Reflect.deleteProperty(elizaWindow, "__ELIZAOS_API_BASE__");
  }
}

export function setElizaApiToken(value: string): void {
  setBootConfig({ ...getBootConfig(), apiToken: readTrimmedString(value) });
}

export function clearElizaApiToken(): void {
  const { apiToken: _apiToken, ...config } = getBootConfig();
  setBootConfig(config);
}
