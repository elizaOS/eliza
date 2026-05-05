import {
  parseToonKeyValue,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ActionFramePayload } from "../sdk/types.js";
import type { ScapeGameService } from "../services/game-service.js";
import { resolveActionText } from "../shared-state.js";
import {
  SCAPE_ACTION_ROUTER_DEFINITIONS,
  resolveScapeRouterAction,
  type ScapeRouterDefinition,
} from "./router-definitions.js";

const MAX_MESSAGE_LENGTH = 80;

type ParamsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ParamsRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function str(params: ParamsRecord, key: string): string {
  return String(params[key] ?? "").trim();
}

function num(params: ParamsRecord, key: string): number {
  return Number(params[key]);
}

async function dispatchGameSubaction(
  service: ScapeGameService,
  subaction: string,
  params: ParamsRecord,
): Promise<{ success: boolean; message?: string }> {
  let action: ActionFramePayload;

  switch (subaction) {
    case "walk_to": {
      const x = num(params, "x");
      const z = num(params, "z");
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        return { success: false, message: "missing x/z" };
      }
      const run = params.run === true || params.run === "true";
      action = { action: "walkTo", x, z, run };
      break;
    }
    case "chat_public": {
      const text = (str(params, "message") || str(params, "text")).slice(
        0,
        MAX_MESSAGE_LENGTH,
      );
      if (!text) return { success: false, message: "missing message" };
      action = { action: "chatPublic", text };
      break;
    }
    case "attack_npc": {
      const npcId = Number(params.npcId ?? params.id);
      if (!Number.isFinite(npcId)) {
        return { success: false, message: "missing npcId" };
      }
      action = { action: "attackNpc", npcId };
      break;
    }
    case "drop_item": {
      const slot = num(params, "slot");
      if (!Number.isInteger(slot) || slot < 0 || slot >= 28) {
        return { success: false, message: "slot must be 0..27" };
      }
      action = { action: "dropItem", slot };
      break;
    }
    case "eat_food": {
      const slotRaw = params.slot;
      const slot =
        slotRaw === undefined || slotRaw === null ? undefined : Number(slotRaw);
      if (
        slot !== undefined &&
        (!Number.isInteger(slot) || slot < 0 || slot >= 28)
      ) {
        return { success: false, message: "slot must be 0..27" };
      }
      action = { action: "eatFood", slot };
      break;
    }
    default:
      return { success: false, message: `unknown game subaction ${subaction}` };
  }

  return service.executeAction(action);
}

function dispatchJournalSubaction(
  service: ScapeGameService,
  subaction: string,
  params: ParamsRecord,
): { success: boolean; message?: string } {
  const journal = service.getJournalService?.();
  if (!journal) return { success: false, message: "journal unavailable" };

  switch (subaction) {
    case "set_goal": {
      const title = str(params, "title");
      if (!title) return { success: false, message: "missing title" };
      const notes = str(params, "notes") || undefined;
      const goal = journal.setGoal({ title, notes, source: "agent" });
      return { success: true, message: `goal set: "${goal.title}"` };
    }
    case "complete_goal": {
      const statusRaw = str(params, "status").toLowerCase() || "completed";
      if (statusRaw !== "completed" && statusRaw !== "abandoned") {
        return { success: false, message: "status must be completed|abandoned" };
      }
      const id = params.id != null ? String(params.id) : undefined;
      const goalId = id ?? journal.getActiveGoal()?.id;
      if (!goalId) return { success: false, message: "no goal to close" };
      const notes = str(params, "notes") || undefined;
      const updated = journal.markGoalStatus(
        goalId,
        statusRaw as "completed" | "abandoned",
        notes,
      );
      if (!updated) return { success: false, message: `goal ${goalId} not found` };
      return { success: true, message: `goal -> ${statusRaw}` };
    }
    case "remember": {
      const text = str(params, "text");
      if (!text) return { success: false, message: "missing text" };
      const kind = str(params, "kind") || "note";
      const weightRaw = Number(params.weight ?? 2);
      const weight = Math.max(1, Math.min(5, Math.floor(weightRaw)));
      const snapshot = service.getPerception();
      journal.addMemory({
        kind,
        text: text.slice(0, 200),
        weight,
        x: snapshot?.self.x,
        z: snapshot?.self.z,
      });
      return { success: true, message: `journal: ${kind} recorded` };
    }
    default:
      return {
        success: false,
        message: `unknown journal subaction ${subaction}`,
      };
  }
}

function createRouterAction(definition: ScapeRouterDefinition): Action {
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
      return runtime.getService("scape_game") != null;
    },
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined,
      options: HandlerOptions | ParamsRecord | undefined,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const service = runtime.getService(
        "scape_game",
      ) as unknown as ScapeGameService | null;
      if (!service) {
        const text = "'scape game service not available.";
        callback?.({ text, action: definition.name });
        return { success: false, text };
      }

      const params = {
        ...paramsFromText(resolveActionText(message)),
        ...paramsFromOptions(options),
      };
      const resolved = resolveScapeRouterAction(
        definition.name,
        params.subaction ?? params.actionType ?? params.type,
      );
      if (!resolved) {
        const text = `${definition.name} requires a valid subaction.`;
        callback?.({ text, action: definition.name });
        return { success: false, text };
      }

      const result =
        definition.name === "SCAPE_GAME"
          ? await dispatchGameSubaction(service, resolved.subaction, params)
          : dispatchJournalSubaction(service, resolved.subaction, params);

      const text = result.message ?? (result.success ? "ok" : "failed");
      callback?.({ text, action: definition.name });
      return { success: result.success, text };
    },
  };
}

export const scapeRouterActions: Action[] =
  SCAPE_ACTION_ROUTER_DEFINITIONS.map(createRouterAction);

export const [scapeGameAction, scapeJournalAction] = scapeRouterActions;
