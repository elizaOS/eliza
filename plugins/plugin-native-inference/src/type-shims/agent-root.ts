/**
 * Type-only boundary for the agent root loaded by mobile bridges.
 * Runtime imports resolve the real package; these declarations let the bridge
 * typecheck without a built agent distribution.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  AndroidCoreRouteDeps,
  AndroidDispatchRoute,
} from "../android/dispatch.ts";

export declare function startEliza(options: {
  serverOnly: true;
  localAgentMode: true;
}): Promise<IAgentRuntime | undefined>;

export declare const dispatchApiRoute: AndroidDispatchRoute;
export declare const configFileExists: AndroidCoreRouteDeps["configFileExists"];
export declare const loadElizaConfig: AndroidCoreRouteDeps["loadElizaConfig"];
export declare const saveElizaConfig: AndroidCoreRouteDeps["saveElizaConfig"];
export declare const hasPersistedFirstRunState: AndroidCoreRouteDeps["hasPersistedFirstRunState"];

export declare function bootElizaRuntime(): Promise<IAgentRuntime>;

export declare function dispatchRoute(args: {
  runtime: IAgentRuntime;
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  inProcess: true;
  isAuthorized: () => true;
}): Promise<
  | {
      status: number;
      headers?: Record<string, string>;
      body?: unknown;
    }
  | null
  | undefined
>;
