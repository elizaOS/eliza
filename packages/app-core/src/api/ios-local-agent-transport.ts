import { Capacitor } from "@capacitor/core";
import { isMobileLocalAgentUrl } from "../onboarding/local-agent-token";
import {
  handleIosLocalAgentRequest,
  startIosLocalAgentKernel,
} from "./ios-local-agent-kernel";
import { createIttpAgentTransport } from "./ittp-agent-transport";
import type { AgentRequestTransport } from "./transport";

let transport: AgentRequestTransport | null = null;

function isNativeIos(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
}

export function isIosInProcessLocalAgentUrl(url: string): boolean {
  return isNativeIos() && isMobileLocalAgentUrl(url);
}

export function isIosInProcessLocalAgentBase(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl) return false;
  return isIosInProcessLocalAgentUrl(`${baseUrl.replace(/\/+$/, "")}/api/health`);
}

export async function iosInProcessAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!isIosInProcessLocalAgentUrl(url)) return null;
  startIosLocalAgentKernel();
  transport ??= createIttpAgentTransport((request, context) =>
    handleIosLocalAgentRequest(request, context),
  );
  return transport;
}
