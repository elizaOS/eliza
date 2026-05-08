import {
  parseJSONObjectFromText,
  type Action,
  type ActionResult as CoreActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ActionResult as PluginActionResult } from "../sdk/types.js";
import { getCurrentLlmResponse } from "../shared-state.js";
import { getRsSdkGameService } from "./game-service.js";
import {
  RS_2004_ACTION_ROUTER_DEFINITIONS,
  resolveRs2004RouterAction,
  type Rs2004RouterDefinition,
} from "./router-definitions.js";

type ParamsRecord = Record<string, unknown>;

/**
 * Bridge the plugin's internal ActionResult ({ success, action, message, details })
 * to the core Handler's expected ActionResult ({ success, text, data }), while
 * preserving the action / details fields on the returned object so existing
 * callers and tests that read `result.action` continue to work.
 */
type RouterActionResult = CoreActionResult & {
  action: string;
  message: string;
  details?: Record<string, unknown>;
};

function toRouterResult(result: PluginActionResult): RouterActionResult {
  return {
    success: result.success,
    text: result.message,
    action: result.action,
    message: result.message,
    details: result.details,
    data: { action: result.action, message: result.message },
  };
}

function routerError(actionName: string, message: string): RouterActionResult {
  return {
    success: false,
    text: message,
    action: actionName,
    message,
    error: message,
    data: { action: actionName, message },
  };
}

function isRecord(value: unknown): value is ParamsRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeParams(params: ParamsRecord, dispatch: string): ParamsRecord {
  const normalized = { ...params };

  if (normalized.npc && !normalized.npcName)
    normalized.npcName = normalized.npc;
  if (normalized.item && !normalized.itemName)
    normalized.itemName = normalized.item;
  if (normalized.object && !normalized.objectName)
    normalized.objectName = normalized.object;
  if (normalized.spell && !normalized.spellId)
    normalized.spellId = normalized.spell;
  if (normalized.item1 && !normalized.itemName1)
    normalized.itemName1 = normalized.item1;
  if (normalized.item2 && !normalized.itemName2)
    normalized.itemName2 = normalized.item2;

  // Per-dispatch target shape — `target` is a generic field on the new
  // *_OP routers, but the underlying actions take typed names.
  if (normalized.target != null) {
    switch (dispatch) {
      case "chopTree":
        normalized.treeName ??= normalized.target;
        break;
      case "mineRock":
        normalized.rockName ??= normalized.target;
        break;
      case "fish":
        normalized.spotName ??= normalized.target;
        break;
      case "cookFood":
        normalized.rawFoodName ??= normalized.target;
        break;
      case "smithAtAnvil":
        normalized.itemName ??= normalized.target;
        break;
      case "attackNpc":
        normalized.npcName ??= normalized.target;
        break;
      case "castSpell":
        normalized.targetNid ??= normalized.target;
        break;
      case "useItemOnItem":
        normalized.itemName2 ??= normalized.target;
        break;
      case "useItemOnObject":
        normalized.objectName ??= normalized.target;
        break;
    }
  }

  if (dispatch === "depositItem" && normalized.count == null) {
    normalized.count = -1;
  }
  if (dispatch === "withdrawItem" && normalized.count == null) {
    normalized.count = 1;
  }

  return normalized;
}

function coerceParamValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return trimmed;
}

function paramsFromText(text: string): ParamsRecord {
  const parsed = parseJSONObjectFromText(text) as ParamsRecord | null;
  if (!parsed) return {};
  const nested = isRecord(parsed.params) ? parsed.params : {};
  const params: ParamsRecord = { ...parsed, ...nested };
  for (const [key, value] of Object.entries(params)) {
    params[key] = coerceParamValue(value);
  }
  return params;
}

function paramsFromOptions(options: unknown): ParamsRecord {
  if (!isRecord(options)) return {};
  const handlerOptions = options as HandlerOptions;
  if (isRecord(handlerOptions.parameters)) {
    return handlerOptions.parameters;
  }
  return options;
}

function resolveActionText(message: Memory | undefined | null): string {
  const messageText = message?.content?.text;
  if (typeof messageText === "string" && messageText.trim().length > 0) {
    return messageText;
  }
  return getCurrentLlmResponse();
}

const SKILL_TO_SUBACTION: Record<string, string> = {
  chop: "chop",
  mine: "mine",
  fish: "fish",
  burn: "burn",
  cook: "cook",
  fletch: "fletch",
  craft: "craft",
  smith: "smith",
};

function pickSubactionFromParams(
  routerName: string,
  params: ParamsRecord,
): unknown {
  if (params.subaction != null) return params.subaction;
  if (routerName === "SKILL" && params.skill != null) {
    const key = String(params.skill).trim().toLowerCase();
    return SKILL_TO_SUBACTION[key] ?? params.skill;
  }
  if (params.op != null) return params.op;
  return params.actionType ?? params.type;
}

function createRouterAction(definition: Rs2004RouterDefinition): Action {
  return {
    name: definition.name,
    description: `${definition.description} Return JSON with action: ${definition.name}, op: one of ${definition.subactions.map((s) => s.name).join("|")}.`,
    descriptionCompressed: definition.descriptionCompressed,
    contexts: ["game", "automation", "world", "state"],
    roleGate: { minRole: "ADMIN" },
    similes: definition.subactions.map((subaction) => subaction.description),
    examples: [],
    parameters: [
      {
        name: "op",
        description: "Router operation to run.",
        descriptionCompressed: "Router operation.",
        required: true,
        schema: {
          type: "string",
          enum: definition.subactions.map((subaction) => subaction.name),
        },
      },
      {
        name: "params",
        description:
          "Optional JSON object containing the fields required by the chosen op.",
        descriptionCompressed: "Op fields.",
        required: false,
        schema: { type: "object" },
      },
    ],
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      return runtime.getService("rs_2004scape") != null;
    },
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined,
      options: HandlerOptions | ParamsRecord | undefined,
      callback?: HandlerCallback,
    ): Promise<RouterActionResult> => {
      const service = getRsSdkGameService(runtime);
      if (!service) {
        return routerError(definition.name, "Game service not available.");
      }

      const params = {
        ...paramsFromText(resolveActionText(message)),
        ...paramsFromOptions(options),
      };
      const resolved = resolveRs2004RouterAction(
        definition.name,
        pickSubactionFromParams(definition.name, params),
      );

      if (!resolved) {
        const errMessage = `${definition.name} requires a valid op.`;
        callback?.({ text: errMessage, action: definition.name });
        return routerError(definition.name, errMessage);
      }

      try {
        const result = await service.executeAction(
          resolved.dispatch,
          normalizeParams(params, resolved.dispatch),
        );
        callback?.({ text: result.message, action: definition.name });
        return toRouterResult(result);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Unknown ${definition.name} failure.`;
        const text = `${definition.name} failed: ${message}`;
        callback?.({ text, action: definition.name });
        return routerError(definition.name, text);
      }
    },
  };
}

const WALK_TO_DESCRIPTION_COMPRESSED =
  "Walk to coordinate or named destination.";

export const rs2004WalkToAction: Action = {
  name: "RS_2004_WALK_TO",
  description:
    "Walk to a coordinate or named destination. Provide either destination: name OR x: N, z: N.",
  descriptionCompressed: WALK_TO_DESCRIPTION_COMPRESSED,
  contexts: ["game", "automation", "world", "state"],
  roleGate: { minRole: "ADMIN" },
  similes: ["MOVE_TO", "GOTO"],
  examples: [],
  parameters: [
    {
      name: "destination",
      description: "Optional named destination (overrides x/z).",
      descriptionCompressed: "Named destination.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "x",
      description: "Target world X coordinate.",
      descriptionCompressed: "Target x.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "z",
      description: "Target world Z coordinate.",
      descriptionCompressed: "Target z.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "reason",
      description: "Optional reason logged with the walk.",
      descriptionCompressed: "Walk reason.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return runtime.getService("rs_2004scape") != null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: HandlerOptions | ParamsRecord | undefined,
    callback?: HandlerCallback,
  ): Promise<RouterActionResult> => {
    const service = getRsSdkGameService(runtime);
    if (!service) {
      return routerError("RS_2004_WALK_TO", "Game service not available.");
    }

    const params = {
      ...paramsFromText(resolveActionText(message)),
      ...paramsFromOptions(options),
    };
    try {
      const result = await service.executeAction("walkTo", params);
      callback?.({ text: result.message, action: "RS_2004_WALK_TO" });
      return toRouterResult(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown walk failure.";
      const text = `RS_2004_WALK_TO failed: ${message}`;
      callback?.({ text, action: "RS_2004_WALK_TO" });
      return routerError("RS_2004_WALK_TO", text);
    }
  },
};

export const rs2004RouterActions: Action[] =
  RS_2004_ACTION_ROUTER_DEFINITIONS.map(createRouterAction);

export const [
  rs2004SkillOpAction,
  rs2004InventoryOpAction,
  rs2004BankOpAction,
  rs2004ShopOpAction,
  rs2004CombatOpAction,
  rs2004InteractOpAction,
] = rs2004RouterActions;

export const rs2004AllActions: Action[] = [
  rs2004WalkToAction,
  ...rs2004RouterActions,
];
