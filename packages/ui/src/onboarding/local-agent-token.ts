import { Capacitor } from "@capacitor/core";
import {
  isAndroidNativeLocalAgentUrl,
  isMobileNativeLocalAgentUrl,
} from "../api/mobile-native-agent-url";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { getElizaApiToken, setElizaApiToken } from "../utils/eliza-globals";

type AgentWithLocalToken = {
  getLocalAgentToken?: () => Promise<{
    available?: boolean;
    token?: string | null;
  }>;
};

const agentPluginName = "Agent";
const agentPluginId = "@elizaos/capacitor-agent";

export function isMobileLocalAgentUrl(value: string): boolean {
  return isMobileNativeLocalAgentUrl(value);
}

export function isAndroidLocalAgentUrl(value: string): boolean {
  return isAndroidNativeLocalAgentUrl(value);
}

function isNativeAndroid(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );
  } catch {
    return false;
  }
}

async function readNativeLocalAgentToken(): Promise<string | null> {
  let agent: AgentWithLocalToken | null = null;
  try {
    const capacitorWithPlugins = Capacitor as typeof Capacitor & {
      Plugins?: Record<string, AgentWithLocalToken | undefined>;
    };
    agent =
      capacitorWithPlugins.Plugins?.[agentPluginName] ??
      Capacitor.registerPlugin<AgentWithLocalToken>(agentPluginName);
  } catch {
    agent = null;
  }

  try {
    if (!agent?.getLocalAgentToken) {
      const mod = (await import(/* @vite-ignore */ agentPluginId)) as {
        Agent?: AgentWithLocalToken;
      };
      agent = mod.Agent ?? null;
    }
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
