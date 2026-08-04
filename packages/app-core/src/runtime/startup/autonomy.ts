/**
 * Prepares the autonomy service and its private world, room, and entity during
 * desktop runtime startup. The runtime host supplies policy; this module owns
 * the persistence compatibility needed across supported runtime adapters.
 */
import {
  type AgentRuntime,
  AUTONOMY_SERVICE_TYPE,
  AutonomyService,
  ChannelType,
  ElizaError,
  logger,
  stringToUuid,
} from "@elizaos/core";

const AUTONOMY_WORLD_ID = stringToUuid("00000000-0000-0000-0000-000000000001");
const AUTONOMY_ENTITY_ID = stringToUuid("00000000-0000-0000-0000-000000000002");
const AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");

type AutonomyServiceLike = {
  enableAutonomy(): Promise<void>;
};

interface EntityLike {
  id: string;
  agentId?: string;
  names?: string[];
  metadata?: Record<string, unknown>;
}

interface RuntimeAutonomyCompat {
  getEntityById(id: string): Promise<EntityLike | null>;
  createEntity(entity: {
    id: string;
    names: string[];
    agentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean>;
  updateEntity?: (entity: EntityLike & { agentId: string }) => Promise<boolean>;
  ensureWorldExists(world: {
    id: string;
    name: string;
    agentId: string;
    messageServerId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  ensureRoomExists(room: {
    id: string;
    name: string;
    worldId: string;
    source: string;
    type: ChannelType;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  ensureParticipantInRoom?: (
    entityId: string,
    roomId: string,
  ) => Promise<unknown>;
  addParticipant?: (entityId: string, roomId: string) => Promise<unknown>;
}

interface RuntimeAdapterAutonomyCompat {
  upsertEntities?: (
    entities: Array<{
      id: string;
      names: string[];
      agentId: string;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<unknown>;
}

function isAutonomyService(value: unknown): value is AutonomyServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "enableAutonomy" in value &&
    typeof value.enableAutonomy === "function"
  );
}

function getAutonomyService(runtime: AgentRuntime): AutonomyServiceLike | null {
  // Older autonomy plugins registered a lowercase service type. Keep this
  // lookup until those independently versioned plugins reach the typed key.
  const service =
    runtime.getService(AUTONOMY_SERVICE_TYPE) ?? runtime.getService("autonomy");
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
  const compatibleRuntime = runtime as AgentRuntime & RuntimeAutonomyCompat;
  const adapter = runtime.adapter as RuntimeAdapterAutonomyCompat | undefined;
  const autonomousRoomId = stringToUuid(`autonomy-room-${runtime.agentId}`);

  await compatibleRuntime.ensureWorldExists({
    id: AUTONOMY_WORLD_ID,
    name: "Autonomy World",
    agentId: runtime.agentId,
    messageServerId: AUTONOMY_MESSAGE_SERVER_ID,
    metadata: {
      type: "autonomy",
      description: "World for autonomous agent thinking",
    },
  });
  await compatibleRuntime.ensureRoomExists({
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
    (await compatibleRuntime.getEntityById(AUTONOMY_ENTITY_ID)) ?? null;

  if (!existingEntity) {
    const created = await compatibleRuntime.createEntity(autonomyEntity);
    if (!created && adapter?.upsertEntities) {
      await adapter.upsertEntities([autonomyEntity]);
    }
  } else if (existingEntity.agentId !== runtime.agentId) {
    if (compatibleRuntime.updateEntity) {
      await compatibleRuntime.updateEntity({
        ...existingEntity,
        agentId: runtime.agentId,
      });
    } else if (adapter?.upsertEntities) {
      await adapter.upsertEntities([
        {
          id: existingEntity.id ?? AUTONOMY_ENTITY_ID,
          names:
            existingEntity.names && existingEntity.names.length > 0
              ? existingEntity.names
              : autonomyEntity.names,
          agentId: runtime.agentId,
          metadata: {
            ...autonomyEntity.metadata,
            ...(existingEntity.metadata ?? {}),
          },
        },
      ]);
    }
  }

  if (compatibleRuntime.ensureParticipantInRoom) {
    await compatibleRuntime.ensureParticipantInRoom(
      runtime.agentId,
      autonomousRoomId,
    );
    await compatibleRuntime.ensureParticipantInRoom(
      AUTONOMY_ENTITY_ID,
      autonomousRoomId,
    );
  } else if (compatibleRuntime.addParticipant) {
    await compatibleRuntime.addParticipant(runtime.agentId, autonomousRoomId);
    await compatibleRuntime.addParticipant(
      AUTONOMY_ENTITY_ID,
      autonomousRoomId,
    );
  }
}

/** Starts the autonomy service and optionally enables its continuous loop. */
export async function configureAutonomy(
  runtime: AgentRuntime,
  loopEnabled: boolean,
): Promise<void> {
  if (loopEnabled) {
    await ensureAutonomyBootstrapContext(runtime);
  } else {
    logger.info(
      "[eliza] Autonomy bootstrap deferred — autonomous loop disabled",
    );
  }

  if (!runtime.getService(AUTONOMY_SERVICE_TYPE)) {
    try {
      await startAndRegisterAutonomyService(runtime);
      logger.info("[eliza] AutonomyService started and waiting");
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
      "[eliza] AutonomyService waiting — set ENABLE_AUTONOMY=true to start autonomous loop",
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
