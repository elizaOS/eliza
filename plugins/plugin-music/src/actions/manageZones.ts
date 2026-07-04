/**
 * Zone-management action for grouped music playback targets.
 *
 * It creates, deletes, inspects, and edits ZoneManager groups through
 * structured action parameters.
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
import type { ZoneManager } from "../router";

type ZoneCommand =
  | { operation: "create"; zoneName: string; targetIds: string[] }
  | { operation: "delete"; zoneName: string }
  | { operation: "show"; zoneName: string }
  | { operation: "list" }
  | { operation: "add"; zoneName: string; targetId: string }
  | { operation: "remove"; zoneName: string; targetId: string };

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

function normalizeZoneOperation(
  value: unknown,
): ZoneCommand["operation"] | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "create" ||
    normalized === "delete" ||
    normalized === "show" ||
    normalized === "list" ||
    normalized === "add" ||
    normalized === "remove"
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

function zoneCommandFromOptions(options: unknown): ZoneCommand | null {
  const params = readParams(options);
  const operation = normalizeZoneOperation(params.operation);
  if (!operation) return null;

  if (operation === "list") return { operation };

  const zoneName = readString(params.zoneName);
  if (!zoneName) return null;

  if (operation === "create") {
    const targetIds = readTargetIds(params);
    return targetIds.length > 0 ? { operation, zoneName, targetIds } : null;
  }
  if (operation === "delete" || operation === "show") {
    return { operation, zoneName };
  }
  const targetId = readTargetIds(params)[0];
  if ((operation === "add" || operation === "remove") && targetId) {
    return { operation, zoneName, targetId };
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
    return zoneCommandFromOptions(options) !== null;
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
      )) as MusicZoneService | null;
      if (!musicService) {
        return emit(callback, source, "Music service not available", false, {
          error: "MUSIC_SERVICE_UNAVAILABLE",
        });
      }

      const zoneManager = (musicService as MusicZoneService).getZoneManager?.();
      if (!zoneManager) {
        return emit(callback, source, "Zone manager not available", false, {
          error: "ZONE_MANAGER_UNAVAILABLE",
        });
      }

      const command = zoneCommandFromOptions(_options);

      if (command?.operation === "create") {
        return Promise.race([
          handleCreateZone(zoneManager, command, effectiveCallback, source),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("zone operation timed out")),
              timeoutMs,
            ),
          ),
        ]);
      } else if (command?.operation === "delete") {
        return handleDeleteZone(
          zoneManager,
          command.zoneName,
          effectiveCallback,
          source,
        );
      } else if (
        command?.operation === "list" ||
        command?.operation === "show"
      ) {
        return handleListZones(zoneManager, command, effectiveCallback, source);
      } else if (command?.operation === "add") {
        return handleAddToZone(zoneManager, command, effectiveCallback, source);
      } else if (command?.operation === "remove") {
        return handleRemoveFromZone(
          zoneManager,
          command,
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
    {
      name: "targetId",
      description: "Single target id to create, add, or remove from a zone.",
      required: false,
      schema: { type: "string" },
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
  command: Extract<ZoneCommand, { operation: "create" }>,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  const { zoneName } = command;
  const targetIds = [...new Set(command.targetIds)];
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
  zoneName: string,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
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
  command: Extract<ZoneCommand, { operation: "list" | "show" }>,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  if (command.operation === "show") {
    const zone = zoneManager.get(command.zoneName);
    if (!zone) {
      return emit(
        callback,
        source,
        `Zone "${command.zoneName}" not found`,
        false,
        {
          error: "ZONE_NOT_FOUND",
          zoneName: command.zoneName,
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
  command: Extract<ZoneCommand, { operation: "add" }>,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  const { targetId, zoneName } = command;
  zoneManager.addTarget(zoneName, targetId);
  logger.log(`[ManageZones] Added "${targetId}" to zone "${zoneName}"`);

  return emit(callback, source, `Added target to zone "${zoneName}"`, true, {
    zoneName,
    targetId,
  });
}

async function handleRemoveFromZone(
  zoneManager: ZoneManager,
  command: Extract<ZoneCommand, { operation: "remove" }>,
  callback: HandlerCallback,
  source: string,
): Promise<ActionResult> {
  const { targetId, zoneName } = command;
  zoneManager.removeTarget(zoneName, targetId);
  logger.log(`[ManageZones] Removed "${targetId}" from zone "${zoneName}"`);

  return emit(
    callback,
    source,
    `Removed target from zone "${zoneName}"`,
    true,
    {
      zoneName,
      targetId,
    },
  );
}

export default manageZones;
