/**
 * WebsiteBlockerService — distraction control via SelfControl-style host
 * blocking on macOS (hosts-file rewrites) and equivalent backends on other
 * platforms.
 *
 * STATUS: stub. The real implementation still lives in:
 *   plugins/plugin-personal-assistant/src/website-blocker/engine.ts        — block/unblock engine
 *   plugins/plugin-personal-assistant/src/website-blocker/service.ts        — Service wrapper
 *   plugins/plugin-personal-assistant/src/website-blocker/access.ts         — admin permission gate
 *   plugins/plugin-personal-assistant/src/website-blocker/permissions.ts    — permission flow
 *   plugins/plugin-personal-assistant/src/website-blocker/public.ts         — public API surface
 *   plugins/plugin-personal-assistant/src/website-blocker/proactive-block-bridge.ts
 *
 * TODO(migration): move the listed files into this directory under
 *   src/services/website-blocker/ and wire them up here. Until that lands the
 *   plugin's service is intentionally a no-op so the package compiles standalone.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

import { BLOCKER_LOG_PREFIX, WEBSITE_BLOCKER_SERVICE_TYPE } from "../types.ts";

export class WebsiteBlockerService extends Service {
  static override readonly serviceType = WEBSITE_BLOCKER_SERVICE_TYPE;

  override capabilityDescription =
    "Website blocking via the SelfControl-style hosts-file engine. Schedules block sessions, manages allow-lists, and gates override approval.";

  static async start(runtime: IAgentRuntime): Promise<WebsiteBlockerService> {
    logger.info(`${BLOCKER_LOG_PREFIX} starting WebsiteBlockerService (stub)`);
    return new WebsiteBlockerService(runtime);
  }

  override async stop(): Promise<void> {
    logger.info(`${BLOCKER_LOG_PREFIX} stopping WebsiteBlockerService (stub)`);
  }

  /**
   * TODO(migration): copy implementation from
   *   plugins/plugin-personal-assistant/src/website-blocker/public.ts
   */
  async listActive(): Promise<readonly never[]> {
    return [];
  }
}
