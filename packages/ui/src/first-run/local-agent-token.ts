/**
 * Manages the local-agent auth token for mobile: reads/writes it via the native
 * agent plugin and boot config, and detects local-agent URLs.
 */
import { Capacitor } from "@capacitor/core";
import { getAgentPlugin } from "../bridge/native-plugins";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { getElizaApiToken, setElizaApiToken } from "../utils/eliza-globals";
import { isMobileLocalAgentUrl } from "./mobile-runtime-mode";

export function isAndroidLocalAgentUrl(value: string): boolean {
  return isMobileLocalAgentUrl(value);
}

function isNativeAndroid(): boolean {
  try {
    return Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

async function readNativeLocalAgentToken(): Promise<string | null> {
  let agent: ReturnType<typeof getAgentPlugin> | null = null;
  try {
    agent = getAgentPlugin();
  } catch {
    agent = null;
  }

  try {
    const result = await agent?.getLocalAgentToken?.();
    const token = result?.token?.trim();
    return result?.available && token ? token : null;
  } catch {
    return null;
  }
}

export async function hydrateAndroidLocalAgentTokenForUrl(
  requestUrl: string,
  options: { force?: boolean } = {},
): Promise<string | null> {
  if (!isAndroidLocalAgentUrl(requestUrl)) return null;
  if (!isNativeAndroid()) return null;

  if (!options.force) {
    const existing = getBootConfig().apiToken?.trim() ?? getElizaApiToken();
    if (existing) return existing;
  }

  const token = await readNativeLocalAgentToken();
  if (!token) return null;

  setBootConfig({ ...getBootConfig(), apiToken: token });
  setElizaApiToken(token);
  return token;
}
