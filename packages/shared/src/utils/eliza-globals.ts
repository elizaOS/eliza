import { getBootConfig, setBootConfig } from "../config/boot-config-store.js";

export type ElizaWindow = Window & {
  __ELIZA_API_BASE__?: string;
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

export function getElizaApiBase(): string | undefined {
  const elizaWindow = getElizaWindow();
  return (
    readTrimmedString(elizaWindow?.__ELIZA_API_BASE__) ??
    readTrimmedString(elizaWindow?.__ELIZAOS_API_BASE__)
  );
}

export function getElizaApiToken(): string | undefined {
  return readTrimmedString(getBootConfig().apiToken);
}

export function setElizaApiBase(value: string): void {
  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    elizaWindow.__ELIZAOS_API_BASE__ = value;
    elizaWindow.__ELIZA_API_BASE__ = value;
  }
}

export function clearElizaApiBase(): void {
  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    Reflect.deleteProperty(elizaWindow, "__ELIZAOS_API_BASE__");
    Reflect.deleteProperty(elizaWindow, "__ELIZA_API_BASE__");
  }
}

export function setElizaApiToken(value: string): void {
  setBootConfig({ ...getBootConfig(), apiToken: readTrimmedString(value) });
}

export function clearElizaApiToken(): void {
  const { apiToken: _apiToken, ...config } = getBootConfig();
  setBootConfig(config);
}
