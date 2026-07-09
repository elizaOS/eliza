/**
 * Routing-management action for the music playback engine.
 *
 * It exposes structured commands for routing mode, broadcast routes, and status
 * over the AudioRouter and ZoneManager boundary.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Service,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { AudioRouter, AudioRoutingMode, ZoneManager } from "../router";
import { selectedContextMatches } from "../utils/selectedContextMatches";

type RoutingCommand =
  | { action: "set_mode"; mode: AudioRoutingMode }
  | {
      action: "start_route";
      sourceId: string;
      targetIds: string[];
      mode?: AudioRoutingMode;
    }
  | { action: "stop_route"; sourceId: string }
  | { action: "status" };

interface MusicRoutingService extends Service {
  capabilityDescription: string;
  stop(): Promise<void>;
  getAudioRouter(): AudioRouter;
  getZoneManager(): ZoneManager;
  setRoutingMode(mode: AudioRoutingMode): void;
  getRoutingMode(): AudioRoutingMode;
  listRoutingTargets(): string[];
  startBroadcastRoute(
    sourceId: string,
    targetIds: string[],
    mode?: AudioRoutingMode,
  ): Promise<{
    sourceId: string;
    targetIds: string[];
    mode: AudioRoutingMode;
  }>;
  stopBroadcastRoute(sourceId: string): Promise<void>;
  getRoutingStatus(): {
    mode: AudioRoutingMode;
    activeRoutes: Array<{
      sourceId: string;
      targetIds: string[];
      mode: AudioRoutingMode;
    }>;
    registeredTargets: string[];
    zoneCount: number;
  };
}

const ROUTING_CONTEXTS = ["media", "automation", "settings"] as const;

async function emit(
  callback: HandlerCallback | undefined,
  source: string,
  text: string,
  success: boolean,
  data?: Record<string, unknown>,
): Promise<ActionResult> {
  await callback?.({ text, source });
  return {
    success,
    text,
    values: { success, ...(data ?? {}) },
    data: { actionName: "MANAGE_ROUTING", ...(data ?? {}) },
  };
}

function readParams(options: unknown): Record<string, unknown> {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeRoutingAction(
  value: unknown,
): RoutingCommand["action"] | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "set_mode" ||
    normalized === "start_route" ||
    normalized === "stop_route" ||
    normalized === "status"
    ? normalized
    : null;
}

function normalizeRoutingMode(value: unknown): AudioRoutingMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "simulcast" || normalized === "independent"
    ? normalized
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => readString(item))
      .filter((item): item is string => Boolean(item));
  }
  return [];
}

function readTargetIds(params: Record<string, unknown>): string[] {
  const targetIds = readStringArray(params.targetIds);
  const targetId = readString(params.targetId);
  return targetId ? [...targetIds, targetId] : targetIds;
}

function routingCommandFromOptions(options: unknown): RoutingCommand | null {
  const params = readParams(options);
  const action = normalizeRoutingAction(
    params.routingAction ?? params.operation,
  );
  if (!action) return null;

  if (action === "set_mode") {
    const mode = normalizeRoutingMode(params.mode);
    return mode ? { action, mode } : null;
  }
  if (action === "start_route") {
    const sourceId = readString(params.sourceId);
    const targetIds = readTargetIds(params);
    if (!sourceId || targetIds.length === 0) return null;
    const mode = normalizeRoutingMode(params.mode);
    return mode
      ? { action, sourceId, targetIds, mode }
      : { action, sourceId, targetIds };
  }
  if (action === "stop_route") {
    const sourceId = readString(params.sourceId);
    return sourceId ? { action, sourceId } : null;
  }
  if (action === "status") return { action };
  return null;
}

/**
 * Action to manage audio routing
 * Allows users to configure simulcast/independent modes and routing assignments
 */
export const manageRouting = {
  name: "MANAGE_ROUTING",
  contexts: ["media", "automation", "settings"],
  contextGate: { anyOf: ["media", "automation", "settings"] },
  roleGate: { minRole: "USER" },
  similes: [
    "SET_ROUTING_MODE",
    "ROUTE_AUDIO",
    "STOP_ROUTING",
    "set mode",
    "route to",
    "simulcast to",
    "independent mode",
    "stop routing",
  ],
  description: "Manage audio routing modes and assignments",
  descriptionCompressed: "manage audio rout mode assignment",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: unknown,
  ) => {
    const musicService = (await runtime.getService(
      "music",
    )) as MusicRoutingService | null;
    if (
      !musicService?.getAudioRouter ||
      !musicService.getZoneManager ||
      !musicService.startBroadcastRoute
    ) {
      return false;
    }
    if (selectedContextMatches(state, ROUTING_CONTEXTS)) return true;
    return routingCommandFromOptions(options) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const timeoutMs = 10_000;
    const source = message.content.source || "unknown";
    const effectiveCallback: HandlerCallback = callback ?? (async () => []);
    try {
      const musicService = (await runtime.getService(
        "music",
      )) as MusicRoutingService | null;
      if (!musicService) {
        return emit(callback, source, "Music service not available", false, {
          error: "MUSIC_SERVICE_UNAVAILABLE",
        });
      }
      const routingService = musicService as MusicRoutingService;
      if (
        !routingService.getAudioRouter ||
        !routingService.getZoneManager ||
        !routingService.startBroadcastRoute
      ) {
        return emit(
          callback,
          source,
          "Audio routing is not available in this runtime",
          false,
          {
            error: "AUDIO_ROUTING_UNAVAILABLE",
          },
        );
      }

      const command = routingCommandFromOptions(_options);

      if (command?.action === "set_mode") {
        return handleSetMode(
          routingService,
          command.mode,
          effectiveCallback,
          source,
        );
      } else if (command?.action === "start_route") {
        return Promise.race([
          handleStartRouting(
            routingService,
            command,
            effectiveCallback,
            source,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("routing operation timed out")),
              timeoutMs,
            ),
          ),
        ]);
      } else if (command?.action === "stop_route") {
        return Promise.race([
          handleStopRouting(
            routingService,
            command.sourceId,
            effectiveCallback,
            source,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("routing stop timed out")),
              timeoutMs,
            ),
          ),
        ]);
      } else if (command?.action === "status") {
        return handleShowRouting(routingService, effectiveCallback, source);
      } else {
        return emit(
          callback,
          source,
          `Available routing commands:
• set mode simulcast|independent
• route <stream> to <zone1>, <zone2>
• simulcast <stream> to all
• stop routing <stream>
• show routing status`,
          false,
          { error: "UNRECOGNIZED_ROUTING_COMMAND" },
        );
      }
    } catch (error) {
      logger.error(`Error managing routing: ${error}`);
      return emit(
        callback,
        source,
        `Error managing routing: ${error instanceof Error ? error.message : String(error)}`,
        false,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  },

  parameters: [
    {
      name: "routingAction",
      description: "Routing action to perform.",
      required: false,
      schema: {
        type: "string",
        enum: ["set_mode", "start_route", "stop_route", "status"],
      },
    },
    {
      name: "mode",
      description: "Audio routing mode.",
      required: false,
      schema: { type: "string", enum: ["simulcast", "independent"] },
    },
    {
      name: "sourceId",
      description: "Stream or source id for routing.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetIds",
      description: "Routing target ids or zone names.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "targetId",
      description: "Single routing target id or zone name.",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "set mode simulcast" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ Routing mode set to: simulcast",
          action: "SET_ROUTING_MODE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "simulcast main-stream to all zones" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "🎵 Broadcasting main-stream to 3 zone(s) in simulcast mode",
          action: "ROUTE_AUDIO",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "stop routing main-stream" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ Stopped routing for main-stream",
          action: "STOP_ROUTING",
        },
      },
    ],
  ],
} as Action;

async function handleSetMode(
  musicService: MusicRoutingService,
  mode: AudioRoutingMode,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  musicService.setRoutingMode(mode);
  logger.log(`[ManageRouting] Set default routing mode to: ${mode}`);

  return emit(callback, source, `Routing mode set to: ${mode}`, true, { mode });
}

async function handleStartRouting(
  musicService: MusicRoutingService,
  command: Extract<RoutingCommand, { action: "start_route" }>,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  const targetIds = resolveTargetIds(musicService, command.targetIds);
  if (targetIds.length === 0) {
    return emit(
      callback,
      source,
      "No routing targets matched. Create zones first or register routing targets.",
      false,
      {
        error: "NO_ROUTING_TARGETS",
      },
    );
  }

  const mode = command.mode ?? musicService.getRoutingMode();
  const route = await musicService.startBroadcastRoute(
    command.sourceId,
    targetIds,
    mode,
  );
  logger.log(
    `[ManageRouting] Routed "${command.sourceId}" to targets: ${targetIds.join(", ")}`,
  );

  return emit(
    callback,
    source,
    `Broadcasting ${route.sourceId} to ${route.targetIds.length} target(s) in ${route.mode} mode`,
    true,
    {
      sourceId: route.sourceId,
      targetIds: route.targetIds,
      mode: route.mode,
    },
  );
}

async function handleStopRouting(
  musicService: MusicRoutingService,
  sourceId: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  await musicService.stopBroadcastRoute(sourceId);
  logger.log(`[ManageRouting] Stopped routing for "${sourceId}"`);

  return emit(callback, source, `Stopped routing for ${sourceId}`, true, {
    sourceId,
  });
}

async function handleShowRouting(
  musicService: MusicRoutingService,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  const status = musicService.getRoutingStatus();
  const routesText = status.activeRoutes.length
    ? status.activeRoutes
        .map(
          (route) =>
            `  - ${route.sourceId} → ${route.targetIds.length} targets (${route.mode})`,
        )
        .join("\n")
    : "  - none";

  return emit(
    callback,
    source,
    `Routing Status:
• Mode: ${status.mode}
• Registered Targets: ${status.registeredTargets.length}
• Zones: ${status.zoneCount}
• Active Routes: ${status.activeRoutes.length}
${routesText}`,
    true,
    { status },
  );
}

function resolveTargetIds(
  musicService: MusicRoutingService,
  selectors: string[],
): string[] {
  const zoneManager = musicService.getZoneManager();
  const registeredTargets = new Set(musicService.listRoutingTargets());

  if (selectors.length === 1 && selectors[0] === "all") {
    const zoneTargets = zoneManager.list().flatMap((zone) => zone.targetIds);
    const allTargets =
      zoneTargets.length > 0 ? zoneTargets : Array.from(registeredTargets);
    return [...new Set(allTargets)];
  }

  const targetIds = new Set<string>();
  for (const selector of selectors) {
    if (zoneManager.exists(selector)) {
      for (const targetId of zoneManager.getTargets(selector)) {
        targetIds.add(targetId);
      }
      continue;
    }
    if (registeredTargets.has(selector)) {
      targetIds.add(selector);
    }
  }

  return Array.from(targetIds);
}

export default manageRouting;
