import type { AgentRequestTransport } from "./transport";
export interface IosLocalAgentNativeRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}
export interface IosLocalAgentNativeRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}
declare global {
  interface Window {
    __ELIZA_API_BASE__?: string;
    __ELIZAOS_API_BASE__?: string;
    __ELIZA_IOS_LOCAL_AGENT_REQUEST__?: (
      options: IosLocalAgentNativeRequestOptions,
    ) => Promise<IosLocalAgentNativeRequestResult>;
  }
}
export declare function isIosInProcessLocalAgentUrl(url: string): boolean;
export declare function isIosInProcessLocalAgentBase(
  baseUrl: string | null | undefined,
): boolean;
export declare function primeIosFullBunRuntime(runtime: unknown): void;
export declare function handleIosLocalAgentNativeRequest(
  options: IosLocalAgentNativeRequestOptions,
): Promise<IosLocalAgentNativeRequestResult>;
export declare function installIosLocalAgentNativeRequestBridge(): void;
export declare function installIosLocalAgentFetchBridge(): void;
export declare function iosInProcessAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null>;
//# sourceMappingURL=ios-local-agent-transport.d.ts.map
