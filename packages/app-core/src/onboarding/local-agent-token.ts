import { Capacitor } from "@capacitor/core";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { getElizaApiToken, setElizaApiToken } from "../utils/eliza-globals";

const LOCAL_AGENT_PORT = "31337";
const LOCAL_AGENT_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type AgentWithLocalToken = {
  getLocalAgentToken?: () => Promise<{
    available?: boolean;
    token?: string | null;
  }>;
};

const agentPluginName = "Agent";
const agentPluginId = "@elizaos/capacitor-agent";

export function isMobileLocalAgentUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.port === LOCAL_AGENT_PORT &&
    LOCAL_AGENT_HOSTS.has(parsed.hostname)
  );
}

export function isAndroidLocalAgentUrl(value: string): boolean {
  return isMobileLocalAgentUrl(value);
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
