/**
 * GoalsCheckinService — daily check-in engine for plugin-goals.
 *
 * STUB. The full implementation will be migrated from:
 *   plugins/plugin-lifeops/src/lifeops/checkin/checkin-service.ts
 *   plugins/plugin-lifeops/src/lifeops/checkin/schedule-resolver.ts
 *   plugins/plugin-lifeops/src/lifeops/checkin/types.ts
 *
 * For the scaffold phase the service exists as a registered Service so the
 * plugin manifest is self-contained. Once foundations (core scheduler,
 * owner-state, registries) land, the LifeOps CheckinService body — collectors,
 * acknowledgement window, escalation ladder, briefing assembly — moves into
 * this file and `plugin-lifeops` re-exports from here.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

import { GOALS_CHECKIN_SERVICE_TYPE, GOALS_LOG_PREFIX } from "../types.ts";

export class GoalsCheckinService extends Service {
  static override readonly serviceType = GOALS_CHECKIN_SERVICE_TYPE;

  override capabilityDescription =
    "Daily check-in engine: morning/night reports, mood/journal capture, acknowledgement-driven tone escalation.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<GoalsCheckinService> {
    logger.info(`${GOALS_LOG_PREFIX} starting GoalsCheckinService`);
    return new GoalsCheckinService(runtime);
  }

  override async stop(): Promise<void> {
    logger.info(`${GOALS_LOG_PREFIX} stopping GoalsCheckinService`);
  }

  // TODO(migrate from plugin-lifeops/src/lifeops/checkin/checkin-service.ts):
  //   - runCheckin(request: RunCheckinRequest): Promise<CheckinReport>
  //   - recordAcknowledgement(request: RecordAcknowledgementRequest): Promise<void>
  //   - briefing assembly: getCheckinBriefing(kind, scope) -> sections
  //   - escalation ladder + acknowledgement window
  //   - collectors for habits / overdue todos / recent wins / sleep recap
}

export function getGoalsCheckinService(
  runtime: IAgentRuntime,
): GoalsCheckinService | null {
  return (
    runtime.getService<GoalsCheckinService>(GoalsCheckinService.serviceType) ??
    null
  );
}
