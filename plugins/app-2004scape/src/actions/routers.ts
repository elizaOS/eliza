import {
  parseToonKeyValue,
  type Action,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { getCurrentLlmResponse } from "../shared-state.js";
import { getRsSdkGameService } from "./game-service.js";
import {
  RS_2004_ACTION_ROUTER_DEFINITIONS,
  resolveRs2004RouterAction,
  type Rs2004RouterDefinition,
} from "./router-definitions.js";

type ParamsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ParamsRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeParams(params: ParamsRecord, dispatch: string): ParamsRecord {
  const normalized = { ...params };

  if (normalized.npc && !normalized.npcName) normalized.npcName = normalized.npc;
  if (normalized.item && !normalized.itemName)
    normalized.itemName = normalized.item;
  if (normalized.object && !normalized.objectName)
    normalized.objectName = normalized.object;
  if (normalized.tree && !normalized.treeName)
    normalized.treeName = normalized.tree;
  if (normalized.rock && !normalized.rockName)
    normalized.rockName = normalized.rock;
  if (normalized.spot && !normalized.spotName)
    normalized.spotName = normalized.spot;
  if (normalized.food && !normalized.rawFoodName)
    normalized.rawFoodName = normalized.food;
  if (normalized.spell && !normalized.spellId)
    normalized.spellId = normalized.spell;
  if (normalized.target && !normalized.targetNid)
    normalized.targetNid = normalized.target;
  if (normalized.item1 && !normalized.itemName1)
    normalized.itemName1 = normalized.item1;
  if (normalized.item2 && !normalized.itemName2)
    normalized.itemName2 = normalized.item2;

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
  const parsed = parseToonKeyValue<ParamsRecord>(text);
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

function createRouterAction(definition: Rs2004RouterDefinition): Action {
  return {
    name: definition.name,
    description: `${definition.description} Return TOON: action: ${definition.name}, subaction: one of ${definition.subactions.map((s) => s.name).join("|")}.`,
    descriptionCompressed: definition.descriptionCompressed,
    similes: definition.subactions.map((subaction) => subaction.description),
    examples: [],
    parameters: [
      {
        name: "subaction",
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
          "Optional TOON object containing the fields required by the chosen subaction.",
        descriptionCompressed: "Subaction fields.",
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
    ): Promise<unknown> => {
      const service = getRsSdkGameService(runtime);
      if (!service) {
        return { success: false, message: "Game service not available." };
      }

      const params = {
        ...paramsFromText(resolveActionText(message)),
        ...paramsFromOptions(options),
      };
      const resolved = resolveRs2004RouterAction(
        definition.name,
        params.subaction ?? params.actionType ?? params.type,
      );

      if (!resolved) {
        const message = `${definition.name} requires a valid subaction.`;
        callback?.({ text: message, action: definition.name });
        return { success: false, message };
      }

      const result = await service.executeAction(
        resolved.dispatch,
        normalizeParams(params, resolved.dispatch),
      );
      callback?.({ text: result.message, action: definition.name });
      return result;
    },
  };
}

export const rs2004RouterActions: Action[] =
  RS_2004_ACTION_ROUTER_DEFINITIONS.map(createRouterAction);

export const [
  rs2004MovementAction,
  rs2004InteractionAction,
  rs2004CombatAction,
  rs2004InventoryAction,
  rs2004BankingAction,
  rs2004ShopAction,
  rs2004SkillingAction,
  rs2004DialogueAction,
] = rs2004RouterActions;
