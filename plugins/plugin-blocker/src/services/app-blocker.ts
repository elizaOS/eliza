/**
 * AppBlockerService — macOS / mobile native app blocking surface.
 *
 * STATUS: stub. Real implementation lives in:
 *   plugins/plugin-personal-assistant/src/app-blocker/engine.ts  — block/unblock engine
 *   plugins/plugin-personal-assistant/src/app-blocker/access.ts  — admin permission gate
 *   plugins/plugin-personal-assistant/src/app-blocker/types.ts   — local types
 *
 * TODO(migration): move the listed files into
 *   src/services/app-blocker/ and wire them up here. Until that lands the
 *   plugin's service is intentionally a no-op so the package compiles standalone.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

import { APP_BLOCKER_SERVICE_TYPE, BLOCKER_LOG_PREFIX } from "../types.ts";

export class AppBlockerService extends Service {
  static override readonly serviceType = APP_BLOCKER_SERVICE_TYPE;

  override capabilityDescription =
    "Native app blocking surface. Schedules block sessions for specific bundle ids and manages allow-lists.";

  static async start(runtime: IAgentRuntime): Promise<AppBlockerService> {
    logger.info(`${BLOCKER_LOG_PREFIX} starting AppBlockerService (stub)`);
    return new AppBlockerService(runtime);
  }

  override async stop(): Promise<void> {
    logger.info(`${BLOCKER_LOG_PREFIX} stopping AppBlockerService (stub)`);
  }

  /**
   * TODO(migration): copy implementation from
   *   plugins/plugin-personal-assistant/src/app-blocker/engine.ts
   */
  async listActive(): Promise<readonly never[]> {
    return [];
  }
}
