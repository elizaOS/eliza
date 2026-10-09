import type { AgentRequestTransport } from "./transport";

/** Transport policy belongs to the application host; standalone web UI uses fetch. */
export type HostTransportPurpose = "agent" | "csrf" | "cloud";
export type HostTransportSelector = (
  url: string,
  purpose: HostTransportPurpose,
  init?: RequestInit,
) => AgentRequestTransport | null | Promise<AgentRequestTransport | null>;

let selectTransport: HostTransportSelector = () => null;

/** Install during host bootstrap, before rendering or dispatching requests. */
export function configureHostTransport(
  selector: HostTransportSelector,
): () => void {
  const previous = selectTransport;
  selectTransport = selector;
  return () => {
    if (selectTransport === selector) selectTransport = previous;
  };
}

export function getHostRequestTransport(
  url: string,
  purpose: HostTransportPurpose,
  init?: RequestInit,
) {
  return selectTransport(url, purpose, init);
}

export interface NativeAgentLifecycle {
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  getStatus?: () => Promise<unknown>;
}
export interface HostAgentCapabilities {
  isInProcessAgentBase: (base: string | null | undefined) => boolean;
  isTerminalBootError: (message: string | null | undefined) => boolean;
  lifecycleForUrl: (
    url: string | null | undefined,
  ) => Promise<NativeAgentLifecycle | null>;
}
let agentCapabilities: HostAgentCapabilities = {
  isInProcessAgentBase: () => false,
  isTerminalBootError: () => false,
  lifecycleForUrl: async () => null,
};
/** Install the native host's policy before initializing the shared client. */
export function configureHostAgentCapabilities(
  capabilities: HostAgentCapabilities,
): () => void {
  const previous = agentCapabilities;
  agentCapabilities = capabilities;
  return () => {
    if (agentCapabilities === capabilities) agentCapabilities = previous;
  };
}
export const isHostInProcessAgentBase = (
  base: string | null | undefined,
): boolean => agentCapabilities.isInProcessAgentBase(base);
export const isTerminalHostAgentBootError = (
  message: string | null | undefined,
): boolean => agentCapabilities.isTerminalBootError(message);
export const hostAgentLifecycleForUrl = (
  url: string | null | undefined,
): Promise<NativeAgentLifecycle | null> =>
  agentCapabilities.lifecycleForUrl(url);

export interface NativeAgentHttpRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}
export interface NativeAgentHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64?: string | null;
  bodyEncoding?: string;
}
