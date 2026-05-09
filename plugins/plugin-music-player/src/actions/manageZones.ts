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
import type { ZoneManager } from "../router";

interface MusicZoneService extends Service {
  capabilityDescription: string;
  stop(): Promise<void>;
  getZoneManager(): ZoneManager;
}

const ZONE_CONTEXTS = ["media", "automation", "settings"] as const;
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
    data: { actionName: "MANAGE_ZONES", ...(data ?? {}) },
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

function zoneTextFromOptions(options: unknown): string | null {
  const params = readParams(options);
  const operation =
    typeof params.operation === "string" ? params.operation.toLowerCase() : "";
  const zoneName =
    typeof params.zoneName === "string" ? params.zoneName.trim() : "";
  const targetIds = Array.isArray(params.targetIds)
    ? params.targetIds.filter(
        (target): target is string => typeof target === "string",
      )
    : [];
  if (operation === "create" && zoneName && targetIds.length > 0) {
    return `create zone ${zoneName} with ${targetIds.join(", ")}`;
  }
  if (operation === "delete" && zoneName) return `delete zone ${zoneName}`;
  if (operation === "show" && zoneName) return `show zone ${zoneName}`;
  if (operation === "list") return "list zones";
  if (operation === "add" && zoneName && targetIds[0]) {
    return `add ${targetIds[0]} to zone ${zoneName}`;
  }
  if (operation === "remove" && zoneName && targetIds[0]) {
    return `remove ${targetIds[0]} from zone ${zoneName}`;
  }
  return null;
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
  contexts: ["media", "automation", "settings"],
  contextGate: { anyOf: ["media", "automation", "settings"] },
  roleGate: { minRole: "USER" },
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
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: unknown,
  ) => {
    const musicService = (await runtime.getService(
      "music",
    )) as MusicZoneService | null;
    if (!musicService?.getZoneManager?.()) {
      return false;
    }
    if (selectedContextMatches(state, ZONE_CONTEXTS)) return true;
    return zoneTextFromOptions(options) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const timeoutMs = 10_000;
    const maxCommandBytes = 2000;
    const source = message.content.source || "unknown";
    const effectiveCallback: HandlerCallback = callback ?? (async () => []);
    try {
      const musicService = (await runtime.getService(
        "music",
      )) as MusicZoneService | null;
      if (!musicService) {
        return emit(callback, source, "Music service not available", false, {
          error: "MUSIC_SERVICE_UNAVAILABLE",
        });
      }

      const zoneManager = (
        musicService as unknown as MusicZoneService
      ).getZoneManager?.();
      if (!zoneManager) {
        return emit(callback, source, "Zone manager not available", false, {
          error: "ZONE_MANAGER_UNAVAILABLE",
        });
      }

      const text = (
        zoneTextFromOptions(_options)?.toLowerCase() ||
        message.content.text?.toLowerCase() ||
        ""
      ).slice(0, maxCommandBytes);

      // Parse command
      if (text.includes("create zone")) {
        return Promise.race([
          handleCreateZone(zoneManager, text, effectiveCallback, source),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("zone operation timed out")),
              timeoutMs,
            ),
          ),
        ]);
      } else if (text.includes("delete zone") || text.includes("remove zone")) {
        return handleDeleteZone(zoneManager, text, effectiveCallback, source);
      } else if (/\b(?:list|show)\s+zones?\b/.test(text)) {
        return handleListZones(zoneManager, text, effectiveCallback, source);
      } else if (/\badd\s+.+\s+to zone\b/.test(text)) {
        return handleAddToZone(zoneManager, text, effectiveCallback, source);
      } else if (/\bremove\s+.+\s+from zone\b/.test(text)) {
        return handleRemoveFromZone(
          zoneManager,
          text,
          effectiveCallback,
          source,
        );
      } else {
        return emit(
          callback,
          source,
          `Available zone commands:
• create zone <name> with <targetIds>
• delete zone <name>
• list zones
• add <targetId> to zone <name>
• remove <targetId> from zone <name>`,
          false,
          { error: "UNRECOGNIZED_ZONE_COMMAND" },
        );
      }
    } catch (error) {
      logger.error(`Error managing zones: ${error}`);
      return emit(
        callback,
        source,
        `Error managing zones: ${error instanceof Error ? error.message : String(error)}`,
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
      description: "Zone operation to perform.",
      required: false,
      schema: {
        type: "string",
        enum: ["create", "delete", "list", "add", "remove", "show"],
      },
    },
    {
      name: "zoneName",
      description: "Audio zone name.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetIds",
      description: "Target ids to create, add, or remove from a zone.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],

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
): Promise<ActionResult> {
  // Parse: "create zone <name> with <targetIds>"
  const match = text.match(/create zone (\w+[\w-]*) with (.+)/);
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: create zone <name> with <targetId1>, <targetId2>, ...",
      false,
      {
        error: "INVALID_CREATE_ZONE_FORMAT",
      },
    );
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

  return emit(
    callback,
    source,
    `Created zone "${zoneName}" with ${targetIds.length} target(s)`,
    true,
    {
      zoneName,
      targetIds,
    },
  );
}

async function handleDeleteZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  // Parse: "delete zone <name>"
  const match = text.match(/(?:delete|remove) zone (\w+[\w-]*)/);
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: delete zone <name>",
      false,
      {
        error: "INVALID_DELETE_ZONE_FORMAT",
      },
    );
  }

  const [, zoneName] = match;
  if (!zoneManager.delete(zoneName)) {
    return emit(callback, source, `Zone "${zoneName}" not found`, false, {
      error: "ZONE_NOT_FOUND",
      zoneName,
    });
  }
  logger.log(`[ManageZones] Deleted zone "${zoneName}"`);

  return emit(callback, source, `Deleted zone "${zoneName}"`, true, {
    zoneName,
  });
}

async function handleListZones(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  const detailMatch = text.match(/show zone (\w+[\w-]*)/);
  if (detailMatch) {
    const zone = zoneManager.get(detailMatch[1]);
    if (!zone) {
      return emit(
        callback,
        source,
        `Zone "${detailMatch[1]}" not found`,
        false,
        {
          error: "ZONE_NOT_FOUND",
          zoneName: detailMatch[1],
        },
      );
    }

    const metadata = zone.metadata
      ? `\nMetadata:\n${formatMetadata(zone.metadata)}`
      : "";
    return emit(
      callback,
      source,
      `Zone "${zone.name}":
• Targets: ${zone.targetIds.length}
• IDs: ${zone.targetIds.join(", ")}${metadata}`,
      true,
      { zone },
    );
  }

  const zones = zoneManager.list();
  logger.log(`[ManageZones] Listing ${zones.length} zone(s)`);

  if (zones.length === 0) {
    return emit(callback, source, "No zones configured yet.", true, {
      zones: [],
    });
  }

  return emit(
    callback,
    source,
    `Active zones:
${zones.map((zone) => `• ${zone.name} (${zone.targetIds.length} targets)`).join("\n")}

Use "show zone <name>" for details`,
    true,
    { zones },
  );
}

async function handleAddToZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  // Parse: "add <targetId> to zone <name>"
  const match = text.match(/add (.+?) to zone (\w+[\w-]*)/);
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: add <targetId> to zone <name>",
      false,
      {
        error: "INVALID_ADD_TO_ZONE_FORMAT",
      },
    );
  }

  const [, targetId, zoneName] = match;
  zoneManager.addTarget(zoneName, targetId.trim());
  logger.log(`[ManageZones] Added "${targetId}" to zone "${zoneName}"`);

  return emit(callback, source, `Added target to zone "${zoneName}"`, true, {
    zoneName,
    targetId: targetId.trim(),
  });
}

async function handleRemoveFromZone(
  zoneManager: ZoneManager,
  text: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  // Parse: "remove <targetId> from zone <name>"
  const match = text.match(/remove (.+?) from zone (\w+[\w-]*)/);
  if (!match) {
    return emit(
      callback,
      source,
      "Invalid format. Use: remove <targetId> from zone <name>",
      false,
      {
        error: "INVALID_REMOVE_FROM_ZONE_FORMAT",
      },
    );
  }

  const [, targetId, zoneName] = match;
  zoneManager.removeTarget(zoneName, targetId.trim());
  logger.log(`[ManageZones] Removed "${targetId}" from zone "${zoneName}"`);

  return emit(
    callback,
    source,
    `Removed target from zone "${zoneName}"`,
    true,
    {
      zoneName,
      targetId: targetId.trim(),
    },
  );
}

export default manageZones;
