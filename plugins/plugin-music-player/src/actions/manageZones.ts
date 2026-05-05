import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { ZoneManager } from "../router";

interface MusicZoneService {
  getZoneManager(): ZoneManager;
}

function formatMetadata(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.join(", ")}`;
      if (value && typeof value === "object") {
        return `${key}: ${Object.keys(value).join(", ")}`;
      }
      return `${key}: ${String(value)}`;
    })
    .join("\n");
}

/**
 * Action to manage audio zones dynamically
 * Allows users to create, delete, and modify zones at runtime
 */
export const manageZones = {
  name: "MANAGE_ZONES",
  similes: [
    "CREATE_ZONE",
    "DELETE_ZONE",
    "LIST_ZONES",
    "ADD_TO_ZONE",
    "REMOVE_FROM_ZONE",
    "manage zones",
    "create zone",
    "delete zone",
    "list zones",
    "show zones",
  ],
  description: "Manage audio zones for multi-bot voice routing",
  descriptionCompressed: "manage audio zone multi-bot voice rout",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ) => {
    const text = message.content.text?.toLowerCase() || "";

    // Check if message is about zone management
    const zoneKeywords = ["zone", "zones", "mix"];
    const actionKeywords = [
      "create",
      "delete",
      "add",
      "remove",
      "list",
      "show",
    ];

    const hasZoneKeyword = zoneKeywords.some((kw) => text.includes(kw));
    const hasActionKeyword = actionKeywords.some((kw) => text.includes(kw));

    return hasZoneKeyword && hasActionKeyword;
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

      const zoneManager = (
        musicService as unknown as MusicZoneService
      ).getZoneManager?.();
      if (!zoneManager) {
        await callback({
          text: "❌ Zone manager not available",
          source,
        });
        return;
      }

      const text = message.content.text?.toLowerCase() || "";

      // Parse command
      if (text.includes("create zone")) {
        await handleCreateZone(zoneManager, text, callback, source);
      } else if (text.includes("delete zone") || text.includes("remove zone")) {
        await handleDeleteZone(zoneManager, text, callback, source);
      } else if (/\b(?:list|show)\s+zones?\b/.test(text)) {
        await handleListZones(zoneManager, text, callback, source);
      } else if (/\badd\s+.+\s+to zone\b/.test(text)) {
        await handleAddToZone(zoneManager, text, callback, source);
      } else if (/\bremove\s+.+\s+from zone\b/.test(text)) {
        await handleRemoveFromZone(zoneManager, text, callback, source);
      } else {
        await callback({
          text: `Available zone commands:
• create zone <name> with <targetIds>
• delete zone <name>
• list zones
• add <targetId> to zone <name>
• remove <targetId> from zone <name>`,
          source,
        });
      }
    } catch (error) {
      logger.error(`Error managing zones: ${error}`);
      await callback({
        text: `❌ Error managing zones: ${error instanceof Error ? error.message : String(error)}`,
        source,
      });
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "create zone main-stage with bot1:guild1:channel1, bot2:guild1:channel2",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '✅ Created zone "main-stage" with 2 targets',
          action: "CREATE_ZONE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "list all zones" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Active zones:\n• main-stage (2 targets)\n• vip-lounge (1 target)",
          action: "LIST_ZONES",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "delete zone main-stage" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '✅ Deleted zone "main-stage"',
          action: "DELETE_ZONE",
        },
      },
    ],
  ],
} as Action;

async function handleCreateZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  // Parse: "create zone <name> with <targetIds>"
  const match = text.match(/create zone (\w+[\w-]*) with (.+)/);
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: create zone <name> with <targetId1>, <targetId2>, ...",
      source,
    });
    return;
  }

  const [, zoneName, targetsStr] = match;
  const targetIds = [
    ...new Set(
      targetsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const zone = zoneManager.create(zoneName, targetIds);
  logger.log(
    `[ManageZones] Created zone "${zone.name}" with targets: ${zone.targetIds.join(", ")}`,
  );

  await callback({
    text: `✅ Created zone "${zoneName}" with ${targetIds.length} target(s)`,
    source,
  });
}

async function handleDeleteZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  // Parse: "delete zone <name>"
  const match = text.match(/(?:delete|remove) zone (\w+[\w-]*)/);
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: delete zone <name>",
      source,
    });
    return;
  }

  const [, zoneName] = match;
  if (!zoneManager.delete(zoneName)) {
    await callback({
      text: `❌ Zone "${zoneName}" not found`,
      source,
    });
    return;
  }
  logger.log(`[ManageZones] Deleted zone "${zoneName}"`);

  await callback({
    text: `✅ Deleted zone "${zoneName}"`,
    source,
  });
}

async function handleListZones(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  const detailMatch = text.match(/show zone (\w+[\w-]*)/);
  if (detailMatch) {
    const zone = zoneManager.get(detailMatch[1]);
    if (!zone) {
      await callback({
        text: `❌ Zone "${detailMatch[1]}" not found`,
        source,
      });
      return;
    }

    const metadata = zone.metadata
      ? `\nMetadata:\n${formatMetadata(zone.metadata)}`
      : "";
    await callback({
      text: `Zone "${zone.name}":
• Targets: ${zone.targetIds.length}
• IDs: ${zone.targetIds.join(", ")}${metadata}`,
      source,
    });
    return;
  }

  const zones = zoneManager.list();
  logger.log(`[ManageZones] Listing ${zones.length} zone(s)`);

  if (zones.length === 0) {
    await callback({
      text: "No zones configured yet.",
      source,
    });
    return;
  }

  await callback({
    text: `Active zones:
${zones.map((zone) => `• ${zone.name} (${zone.targetIds.length} targets)`).join("\n")}

Use "show zone <name>" for details`,
    source,
  });
}

async function handleAddToZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  // Parse: "add <targetId> to zone <name>"
  const match = text.match(/add (.+?) to zone (\w+[\w-]*)/);
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: add <targetId> to zone <name>",
      source,
    });
    return;
  }

  const [, targetId, zoneName] = match;
  zoneManager.addTarget(zoneName, targetId.trim());
  logger.log(`[ManageZones] Added "${targetId}" to zone "${zoneName}"`);

  await callback({
    text: `✅ Added target to zone "${zoneName}"`,
    source,
  });
}

async function handleRemoveFromZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
) {
  // Parse: "remove <targetId> from zone <name>"
  const match = text.match(/remove (.+?) from zone (\w+[\w-]*)/);
  if (!match) {
    await callback({
      text: "❌ Invalid format. Use: remove <targetId> from zone <name>",
      source,
    });
    return;
  }

  const [, targetId, zoneName] = match;
  zoneManager.removeTarget(zoneName, targetId.trim());
  logger.log(`[ManageZones] Removed "${targetId}" from zone "${zoneName}"`);

  await callback({
    text: `✅ Removed target from zone "${zoneName}"`,
    source,
  });
}

export default manageZones;
