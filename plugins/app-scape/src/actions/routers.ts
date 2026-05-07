import {
  parseJSONObjectFromText,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ScapeGameService } from "../services/game-service.js";
import { resolveActionText } from "../shared-state.js";
import {
  SCAPE_ACTION_ROUTER_DEFINITIONS,
  resolveScapeRouterAction,
  type ScapeRouterDefinition,
} from "./router-definitions.js";

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

function str(params: ParamsRecord, key: string): string {
  return String(params[key] ?? "").trim();
}

function dispatchInventoryOp(
  service: ScapeGameService,
  subaction: string,
  params: ParamsRecord,
): Promise<{ success: boolean; message?: string }> {
  switch (subaction) {
    case "drop": {
      const slot = Number(params.item ?? params.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= 28) {
        return Promise.resolve({
          success: false,
          message: "item must be slot 0..27",
        });
      }
      return service.executeAction({ action: "dropItem", slot });
    }
    case "eat": {
      const raw = params.item ?? params.slot;
      const slot = raw === undefined || raw === null ? undefined : Number(raw);
      if (
        slot !== undefined &&
        (!Number.isInteger(slot) || slot < 0 || slot >= 28)
      ) {
        return Promise.resolve({
          success: false,
          message: "item must be slot 0..27",
        });
      }
      return service.executeAction({ action: "eatFood", slot });
    }
    default:
      return Promise.resolve({
        success: false,
        message: `unknown inventory op ${subaction}`,
      });
  }
}

function dispatchJournalOp(
  service: ScapeGameService,
  subaction: string,
  params: ParamsRecord,
): { success: boolean; message?: string } {
  const journal = service.getJournalService?.();
  if (!journal) return { success: false, message: "journal unavailable" };

  switch (subaction) {
    case "set-goal": {
      const title = str(params, "title");
      if (!title) return { success: false, message: "missing title" };
      const notes = str(params, "notes") || undefined;
      const goal = journal.setGoal({ title, notes, source: "agent" });
      return { success: true, message: `goal set: "${goal.title}"` };
    }
    case "complete-goal": {
      const statusRaw = str(params, "status").toLowerCase() || "completed";
      if (statusRaw !== "completed" && statusRaw !== "abandoned") {
        return {
          success: false,
          message: "status must be completed|abandoned",
        };
      }
      const explicitId =
        params.goalId != null
          ? String(params.goalId)
          : params.id != null
            ? String(params.id)
            : undefined;
      const goalId = explicitId ?? journal.getActiveGoal()?.id;
      if (!goalId) return { success: false, message: "no goal to close" };
      const notes = str(params, "notes") || undefined;
      const updated = journal.markGoalStatus(
        goalId,
        statusRaw as "completed" | "abandoned",
        notes,
      );
      if (!updated)
        return { success: false, message: `goal ${goalId} not found` };
      return { success: true, message: `goal -> ${statusRaw}` };
    }
    case "remember": {
      const text = str(params, "notes") || str(params, "text");
      if (!text) return { success: false, message: "missing notes" };
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
        message: `unknown journal op ${subaction}`,
      };
  }
}

function createRouterAction(definition: ScapeRouterDefinition): Action {
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
        descriptionCompressed: "Router op.",
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
        params.op ?? params.subaction ?? params.actionType ?? params.type,
      );
      if (!resolved) {
        const text = `${definition.name} requires a valid op.`;
        callback?.({ text, action: definition.name });
        return { success: false, text };
      }

      const result =
        definition.name === "INVENTORY_OP"
          ? await dispatchInventoryOp(service, resolved.subaction, params)
          : dispatchJournalOp(service, resolved.subaction, params);

      const text = result.message ?? (result.success ? "ok" : "failed");
      callback?.({ text, action: definition.name });
      return { success: result.success, text };
    },
  };
}

export const scapeRouterActions: Action[] =
  SCAPE_ACTION_ROUTER_DEFINITIONS.map(createRouterAction);

export const [scapeJournalAction, scapeInventoryAction] = scapeRouterActions;
