import { type IAgentRuntime, logger, Service } from "@elizaos/core";

import { APP_BLOCKER_SERVICE_TYPE, BLOCKER_LOG_PREFIX } from "../../types.ts";
import { getAppBlockerStatus } from "./engine.ts";
import type { AppBlockerStatus } from "./types.ts";

/**
 * AppBlockerService — native mobile app blocking surface (iOS Family Controls,
 * Android Usage Access overlay). Backed by the Capacitor app-blocker engine.
 */
export class AppBlockerService extends Service {
  static override readonly serviceType = APP_BLOCKER_SERVICE_TYPE;

  override capabilityDescription =
    "Native app blocking surface. Schedules block sessions for specific bundle ids and manages allow-lists.";

  static async start(runtime: IAgentRuntime): Promise<AppBlockerService> {
    logger.info(`${BLOCKER_LOG_PREFIX} starting AppBlockerService`);
    return new AppBlockerService(runtime);
  }

  override async stop(): Promise<void> {
    logger.info(`${BLOCKER_LOG_PREFIX} stopping AppBlockerService`);
  }

  async getStatus(): Promise<AppBlockerStatus> {
    return getAppBlockerStatus();
  }
}
