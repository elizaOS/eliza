import { type AgentRequestTransport } from "./transport";
export interface NativeAgentRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}
export interface NativeAgentRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
}
type NativeAgentPlugin = {
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  getStatus?: () => Promise<unknown>;
  request?: (
    options: NativeAgentRequestOptions,
  ) => Promise<NativeAgentRequestResult>;
};
declare global {
  interface Window {
    __ELIZA_API_BASE__?: string;
    __ELIZAOS_API_BASE__?: string;
  }
}
export declare function createAndroidNativeAgentTransport(
  agent: NativeAgentPlugin,
): AgentRequestTransport;
export declare function androidNativeAgentLifecycleForUrl(
  url: string | null | undefined,
): Promise<NativeAgentPlugin | null>;
export declare function androidNativeAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null>;
export declare function installAndroidNativeAgentFetchBridge(): void;
export declare function __resetAndroidNativeAgentTransportForTests(): void;
//# sourceMappingURL=android-native-agent-transport.d.ts.map
