import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import {
  APP_SESSION_SERVICE_TYPE,
  type AppRunSummary,
  type AppSessionServiceLike,
} from "@elizaos/shared";
import { readAppRunStore } from "./app-run-store.ts";

/**
 * Runtime service exposing the AppManager run store to in-runtime consumers
 * (the agent's hosted-app session gate) via `runtime.getService`. This inverts
 * the previous host→plugin static import: the agent no longer imports
 * `readAppRunStore` from this plugin; it queries this service instead, and
 * treats its absence as "no active runs".
 */
export class AppSessionService
  extends Service
  implements AppSessionServiceLike
{
  static override serviceType = APP_SESSION_SERVICE_TYPE;

  override capabilityDescription =
    "Exposes AppManager run state so hosted-app plugins can gate on active sessions.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<AppSessionService> {
    return new AppSessionService(runtime);
  }

  getRuns(): AppRunSummary[] {
    return readAppRunStore();
  }

  override async stop(): Promise<void> {}
}
