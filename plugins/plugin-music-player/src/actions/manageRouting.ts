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
const ROUTING_KEYWORDS = [
  "route",
  "routing",
  "simulcast",
  "broadcast",
  "stream",
  "zone",
  "mode",
  "audio",
  "music",
  "ruta",
  "enrutar",
  "transmitir",
  "zona",
  "modo",
  "musica",
  "routage",
  "diffuser",
  "zone",
  "modus",
  "weiterleiten",
  "übertragen",
  "ルーティング",
  "配信",
  "ゾーン",
  "路由",
  "广播",
  "区域",
  "라우팅",
  "방송",
  "구역",
] as const;

function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

function messageContainsAny(
  message: Memory,
  state: State | undefined,
  keywords: readonly string[],
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

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

function routingTextFromOptions(options: unknown): string | null {
  const params = readParams(options);
  const operation =
    typeof params.operation === "string" ? params.operation.toLowerCase() : "";
  const mode = typeof params.mode === "string" ? params.mode.toLowerCase() : "";
  const sourceId =
    typeof params.sourceId === "string" ? params.sourceId.trim() : "";
  const targetIds = Array.isArray(params.targetIds)
    ? params.targetIds.filter(
        (target): target is string => typeof target === "string",
      )
    : [];
  if (operation === "set_mode" && mode) return `set mode ${mode}`;
  if (operation === "start_route" && sourceId && targetIds.length > 0) {
    return `route ${sourceId} to ${targetIds.join(", ")}`;
  }
  if (operation === "stop_route" && sourceId) return `stop routing ${sourceId}`;
  if (operation === "status") return "show routing status";
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

  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    if (selectedContextMatches(state, ROUTING_CONTEXTS)) return true;
    const text = message.content.text?.toLowerCase() || "";

    const hasRelevantKeyword = messageContainsAny(
      message,
      state,
      ROUTING_KEYWORDS,
    );
    const actionKeywords = ["set", "start", "stop", "switch"];
    const hasActionKeyword = actionKeywords.some((kw) => text.includes(kw));

    return hasRelevantKeyword && hasActionKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
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
      const routingService = musicService as unknown as MusicRoutingService;
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

      const text =
        routingTextFromOptions(_options)?.toLowerCase() ||
        message.content.text?.toLowerCase() ||
        "";

      // Parse command
      if (text.includes("set mode") || text.includes("switch mode")) {
        return handleSetMode(routingService, text, effectiveCallback, source);
      } else if (
        /\bsimulcast\s+.+\s+to\b/.test(text) ||
        /\broute\s+.+\s+to\b/.test(text)
      ) {
        return handleStartRouting(
          routingService,
          text,
          effectiveCallback,
          source,
        );
      } else if (text.includes("stop routing")) {
        return handleStopRouting(
          routingService,
          text,
          effectiveCallback,
          source,
        );
      } else if (
        text.includes("show routing") ||
        text.includes("routing status")
      ) {
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
      name: "operation",
      description: "Routing operation to perform.",
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
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  // Parse: "set mode <simulcast|independent>"
  const match = text.match(/(?:set|switch) mode (simulcast|independent)/);
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: set mode simulcast|independent",
      false,
      {
        error: "INVALID_MODE_FORMAT",
      },
    );
  }

  const [, mode] = match;
  musicService.setRoutingMode(mode as AudioRoutingMode);
  logger.log(`[ManageRouting] Set default routing mode to: ${mode}`);

  return emit(callback, source, `Routing mode set to: ${mode}`, true, { mode });
}

async function handleStartRouting(
  musicService: MusicRoutingService,
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  // Parse: "route <stream> to <zones>" or "simulcast <stream> to <zones>"
  const routeMatch = text.match(/route (.+?) to (.+)/);
  const simulcastMatch = text.match(/simulcast (.+?) to (.+)/);

  const match = routeMatch || simulcastMatch;
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: route <stream> to <zone1>, <zone2> or simulcast <stream> to all",
      false,
      {
        error: "INVALID_ROUTE_FORMAT",
      },
    );
  }

  const [, streamId, zonesStr] = match;
  const selectors = zonesStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const targetIds = resolveTargetIds(musicService, selectors);
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

  const mode = simulcastMatch ? "simulcast" : musicService.getRoutingMode();
  const route = await musicService.startBroadcastRoute(
    streamId.trim(),
    targetIds,
    mode,
  );
  logger.log(
    `[ManageRouting] Routed "${streamId}" to targets: ${targetIds.join(", ")}`,
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
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  // Parse: "stop routing <stream>"
  const match = text.match(/stop routing (.+)/);
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: stop routing <stream>",
      false,
      {
        error: "INVALID_STOP_ROUTE_FORMAT",
      },
    );
  }

  const [, streamId] = match;
  await musicService.stopBroadcastRoute(streamId.trim());
  logger.log(`[ManageRouting] Stopped routing for "${streamId}"`);

  return emit(callback, source, `Stopped routing for ${streamId}`, true, {
    sourceId: streamId.trim(),
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

  if (selectors.length === 1 && selectors[0].includes("all")) {
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
