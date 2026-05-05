import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { AudioRouter, AudioRoutingMode, ZoneManager } from "../router";

interface MusicRoutingService {
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

/**
 * Action to manage audio routing
 * Allows users to configure simulcast/independent modes and routing assignments
 */
export const manageRouting = {
  name: "MANAGE_ROUTING",
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
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ) => {
    const text = message.content.text?.toLowerCase() || "";

    // Check if message is about routing
    const routingKeywords = ["route", "routing", "simulcast", "mode", "stream"];
    const actionKeywords = ["set", "start", "stop", "switch"];

    const hasRoutingKeyword = routingKeywords.some((kw) => text.includes(kw));
    const hasActionKeyword = actionKeywords.some((kw) => text.includes(kw));

    return hasRoutingKeyword && hasActionKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: any,
    callback?: HandlerCallback,
  ) => {
    if (!callback) return;
    const source = message.content.source || "unknown";
    try {
      const musicService = await runtime.getService("music" as any);
      if (!musicService) {
        await callback({
          text: "❌ Music service not available",
          source,
        });
        return;
      }
      const routingService = musicService as unknown as MusicRoutingService;
      if (
        !routingService.getAudioRouter ||
        !routingService.getZoneManager ||
        !routingService.startBroadcastRoute
      ) {
        await callback({
          text: "❌ Audio routing is not available in this runtime",
          source,
        });
        return;
      }

      const text = message.content.text?.toLowerCase() || "";

      // Parse command
      if (text.includes("set mode") || text.includes("switch mode")) {
        await handleSetMode(routingService, text, callback, source);
      } else if (
        /\bsimulcast\s+.+\s+to\b/.test(text) ||
        /\broute\s+.+\s+to\b/.test(text)
      ) {
        await handleStartRouting(routingService, text, callback, source);
      } else if (text.includes("stop routing")) {
        await handleStopRouting(routingService, text, callback, source);
      } else if (
        text.includes("show routing") ||
        text.includes("routing status")
      ) {
        await handleShowRouting(routingService, callback, source);
      } else {
        await callback({
          text: `Available routing commands:
• set mode simulcast|independent
• route <stream> to <zone1>, <zone2>
• simulcast <stream> to all
• stop routing <stream>
• show routing status`,
          source,
        });
      }
    } catch (error) {
      logger.error(`Error managing routing: ${error}`);
      await callback({
        text: `❌ Error managing routing: ${error instanceof Error ? error.message : String(error)}`,
        source,
      });
    }
  },

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
) {
  // Parse: "set mode <simulcast|independent>"
  const match = text.match(/(?:set|switch) mode (simulcast|independent)/);
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: set mode simulcast|independent",
      source,
    });
    return;
  }

  const [, mode] = match;
  musicService.setRoutingMode(mode as AudioRoutingMode);
  logger.log(`[ManageRouting] Set default routing mode to: ${mode}`);

  await callback({
    text: `✅ Routing mode set to: ${mode}`,
    source,
  });
}

async function handleStartRouting(
  musicService: MusicRoutingService,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  // Parse: "route <stream> to <zones>" or "simulcast <stream> to <zones>"
  const routeMatch = text.match(/route (.+?) to (.+)/);
  const simulcastMatch = text.match(/simulcast (.+?) to (.+)/);

  const match = routeMatch || simulcastMatch;
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: route <stream> to <zone1>, <zone2> or simulcast <stream> to all",
      source,
    });
    return;
  }

  const [, streamId, zonesStr] = match;
  const selectors = zonesStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const targetIds = resolveTargetIds(musicService, selectors);
  if (targetIds.length === 0) {
    await callback({
      text: "❌ No routing targets matched. Create zones first or register routing targets.",
      source,
    });
    return;
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

  await callback({
    text: `🎵 Broadcasting ${route.sourceId} to ${route.targetIds.length} target(s) in ${route.mode} mode`,
    source,
  });
}

async function handleStopRouting(
  musicService: MusicRoutingService,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  // Parse: "stop routing <stream>"
  const match = text.match(/stop routing (.+)/);
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: stop routing <stream>",
      source,
    });
    return;
  }

  const [, streamId] = match;
  await musicService.stopBroadcastRoute(streamId.trim());
  logger.log(`[ManageRouting] Stopped routing for "${streamId}"`);

  await callback({
    text: `✅ Stopped routing for ${streamId}`,
    source,
  });
}

async function handleShowRouting(
  musicService: MusicRoutingService,
  callback: HandlerCallback,
  source: string,
) {
  const status = musicService.getRoutingStatus();
  const routesText = status.activeRoutes.length
    ? status.activeRoutes
        .map(
          (route) =>
            `  - ${route.sourceId} → ${route.targetIds.length} targets (${route.mode})`,
        )
        .join("\n")
    : "  - none";

  await callback({
    text: `📊 Routing Status:
• Mode: ${status.mode}
• Registered Targets: ${status.registeredTargets.length}
• Zones: ${status.zoneCount}
• Active Routes: ${status.activeRoutes.length}
${routesText}`,
    source,
  });
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
