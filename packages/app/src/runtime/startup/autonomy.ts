/**
 * Prepares the autonomy service and its private world, room, and entity during
 * desktop runtime startup. The runtime host supplies policy; this module owns
 * its persisted bootstrap context.
 */

import {
  type AgentRuntime,
  ChannelType,
  ElizaError,
  logger,
  stringToUuid,
} from "@elizaos/core";
import {
  AUTONOMY_SERVICE_TYPE,
  AutonomyService,
} from "@elizaos/plugin-assistant";

const AUTONOMY_WORLD_ID = stringToUuid("00000000-0000-0000-0000-000000000001");
const AUTONOMY_ENTITY_ID = stringToUuid("00000000-0000-0000-0000-000000000002");
const AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");

type AutonomyServiceLike = {
  enableAutonomy(): Promise<void>;
};

function isAutonomyService(value: unknown): value is AutonomyServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "enableAutonomy" in value &&
    typeof value.enableAutonomy === "function"
  );
}

function getAutonomyService(runtime: AgentRuntime): AutonomyServiceLike | null {
  const service = runtime.getService(AUTONOMY_SERVICE_TYPE);
  return isAutonomyService(service) ? service : null;
}

async function startAndRegisterAutonomyService(
  runtime: AgentRuntime,
): Promise<AutonomyServiceLike> {
  const service = await AutonomyService.start(runtime);
  runtime.services.set(AUTONOMY_SERVICE_TYPE as never, [service as never]);
  return service;
}

async function ensureAutonomyBootstrapContext(
  runtime: AgentRuntime,
): Promise<void> {
  const autonomousRoomId = stringToUuid(`autonomy-room-${runtime.agentId}`);

  await runtime.ensureWorldExists({
    id: AUTONOMY_WORLD_ID,
    name: "Autonomy World",
    agentId: runtime.agentId,
    messageServerId: AUTONOMY_MESSAGE_SERVER_ID,
    metadata: {
      type: "autonomy",
      description: "World for autonomous agent thinking",
    },
  });
  await runtime.ensureRoomExists({
    id: autonomousRoomId,
    name: "Autonomous Thoughts",
    worldId: AUTONOMY_WORLD_ID,
    source: "autonomy-service",
    type: ChannelType.SELF,
    metadata: {
      source: "autonomy-service",
      description: "Room for autonomous agent thinking",
    },
  });

  const autonomyEntity = {
    id: AUTONOMY_ENTITY_ID,
    names: ["Autonomy"],
    agentId: runtime.agentId,
    metadata: {
      type: "autonomy",
      description: "Dedicated entity for autonomy service prompts",
    },
  };
  const existingEntity =
    (await runtime.getEntityById(AUTONOMY_ENTITY_ID)) ?? null;

  if (!existingEntity) {
    if (!(await runtime.createEntity(autonomyEntity))) {
      await runtime.upsertEntities([autonomyEntity]);
    }
  } else if (existingEntity.agentId !== runtime.agentId) {
    await runtime.updateEntity({ ...existingEntity, agentId: runtime.agentId });
  }

  await runtime.ensureParticipantInRoom(runtime.agentId, autonomousRoomId);
  await runtime.ensureParticipantInRoom(AUTONOMY_ENTITY_ID, autonomousRoomId);
}

/** Starts the autonomy service and optionally enables its continuous loop. */
export async function configureAutonomy(
  runtime: AgentRuntime,
  loopEnabled: boolean,
): Promise<void> {
  if (loopEnabled) {
    await ensureAutonomyBootstrapContext(runtime);
  }

  if (!runtime.getService(AUTONOMY_SERVICE_TYPE)) {
    try {
      await startAndRegisterAutonomyService(runtime);
    } catch (error) {
      // error-policy:J2 startup must identify the failed subsystem while
      // retaining the service error for boundary diagnostics.
      throw new ElizaError("Autonomy service startup failed", {
        code: "APP_AUTONOMY_START_FAILED",
        cause: error,
        context: { agentId: runtime.agentId },
        severity: "fatal",
      });
    }
  }

  if (!loopEnabled) {
    logger.info(
      "[eliza] Autonomy loop disabled; trigger service ready — set ENABLE_AUTONOMY=true to enable continuous autonomy",
    );
    return;
  }

  const service = getAutonomyService(runtime);
  if (!service) {
    throw new ElizaError("Autonomy service was not registered after startup", {
      code: "APP_AUTONOMY_SERVICE_MISSING",
      context: { agentId: runtime.agentId },
      severity: "fatal",
    });
  }
  try {
    await service.enableAutonomy();
    logger.info(
      "[eliza] AutonomyService enabled — trigger instructions will be processed",
    );
  } catch (error) {
    // error-policy:J2 startup must preserve the enablement error for the host
    // boundary while adding stable subsystem context.
    throw new ElizaError("Autonomy loop enablement failed", {
      code: "APP_AUTONOMY_ENABLE_FAILED",
      cause: error,
      context: { agentId: runtime.agentId },
      severity: "fatal",
    });
  }
}
