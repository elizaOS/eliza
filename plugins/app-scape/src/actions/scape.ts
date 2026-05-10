/**
 * SCAPE — single Pattern C parent action that absorbs every old leaf:
 *
 *   op: walk_to | attack | chat_public | eat | drop |
 *       set_goal | complete_goal | remember
 *
 * Per-op param shape:
 *   walk_to       { x, z, run? }
 *   attack        { npcId }
 *   chat_public   { message }                           (game-world chat,
 *                                                       NOT a connector send)
 *   eat           { item? }                             (slot 0..27)
 *   drop          { item }                              (slot 0..27)
 *   set_goal      { title, notes? }
 *   complete_goal { status?, goalId?, notes? }
 *   remember      { notes, kind?, weight? }
 *
 * Old leaf names (`SCAPE_WALK_TO`, `ATTACK_NPC`, `CHAT_PUBLIC`,
 * `JOURNAL_OP`, `INVENTORY_OP`, plus the legacy verbs `SET_GOAL`,
 * `COMPLETE_GOAL`, `REMEMBER`, `EAT_FOOD`, `DROP_ITEM`) live on as
 * similes so older inbound prompts still resolve to this parent.
 */

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

type ParamsRecord = Record<string, unknown>;

type ScapeOp =
  | "walk_to"
  | "attack"
  | "chat_public"
  | "eat"
  | "drop"
  | "set_goal"
  | "complete_goal"
  | "remember";

const SCAPE_OPS: readonly ScapeOp[] = [
  "walk_to",
  "attack",
  "chat_public",
  "eat",
  "drop",
  "set_goal",
  "complete_goal",
  "remember",
] as const;

const MAX_CHAT_LENGTH = 80;
const TIMEOUT_MS = 15_000;

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

function num(params: ParamsRecord, key: string): number | null {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Map an LLM-supplied op string (any case, with `-` or `_`, with or
 * without legacy verbs like `SET_GOAL`) to the canonical op enum.
 */
function normalizeOp(value: unknown): ScapeOp | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  switch (normalized) {
    case "walk_to":
    case "walkto":
    case "scape_walk_to":
    case "move_to":
    case "go_to":
    case "travel_to":
      return "walk_to";
    case "attack":
    case "attack_npc":
    case "fight_npc":
    case "kill_npc":
      return "attack";
    case "chat_public":
    case "say":
    case "speak":
    case "talk":
    case "broadcast":
      return "chat_public";
    case "eat":
    case "eat_food":
      return "eat";
    case "drop":
    case "drop_item":
      return "drop";
    case "set_goal":
    case "setgoal":
      return "set_goal";
    case "complete_goal":
    case "completegoal":
      return "complete_goal";
    case "remember":
      return "remember";
    default:
      return SCAPE_OPS.includes(normalized as ScapeOp)
        ? (normalized as ScapeOp)
        : null;
  }
}

async function dispatchOp(
  service: ScapeGameService,
  op: ScapeOp,
  params: ParamsRecord,
): Promise<{ success: boolean; message?: string }> {
  switch (op) {
    case "walk_to": {
      const x = num(params, "x");
      const z = num(params, "z");
      if (x === null || z === null) {
        return { success: false, message: "walk_to requires x and z" };
      }
      const run = params.run === true || params.run === "true";
      return await service.executeAction({ action: "walkTo", x, z, run });
    }
    case "attack": {
      const npcId = num(params, "npcId") ?? num(params, "id");
      if (npcId === null) {
        return { success: false, message: "attack requires npcId" };
      }
      return await service.executeAction({ action: "attackNpc", npcId });
    }
    case "chat_public": {
      const message = str(params, "message") || str(params, "text");
      if (!message) {
        return { success: false, message: "chat_public requires message" };
      }
      const trimmed = message.slice(0, MAX_CHAT_LENGTH);
      return await service.executeAction({
        action: "chatPublic",
        text: trimmed,
      });
    }
    case "drop": {
      const slot = num(params, "item") ?? num(params, "slot");
      if (slot === null || !Number.isInteger(slot) || slot < 0 || slot >= 28) {
        return { success: false, message: "item must be slot 0..27" };
      }
      return await service.executeAction({ action: "dropItem", slot });
    }
    case "eat": {
      const raw = params.item ?? params.slot;
      const slot = raw === undefined || raw === null ? undefined : Number(raw);
      if (
        slot !== undefined &&
        (!Number.isInteger(slot) || slot < 0 || slot >= 28)
      ) {
        return { success: false, message: "item must be slot 0..27" };
      }
      return await service.executeAction({ action: "eatFood", slot });
    }
    case "set_goal": {
      const journal = service.getJournalService?.();
      if (!journal) return { success: false, message: "journal unavailable" };
      const title = str(params, "title");
      if (!title) return { success: false, message: "missing title" };
      const notes = str(params, "notes") || undefined;
      const goal = journal.setGoal({ title, notes, source: "agent" });
      return { success: true, message: `goal set: "${goal.title}"` };
    }
    case "complete_goal": {
      const journal = service.getJournalService?.();
      if (!journal) return { success: false, message: "journal unavailable" };
      const statusRaw = str(params, "status").toLowerCase() || "completed";
      if (statusRaw !== "completed" && statusRaw !== "abandoned") {
        return { success: false, message: "status must be completed|abandoned" };
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
      if (!updated) return { success: false, message: `goal ${goalId} not found` };
      return { success: true, message: `goal -> ${statusRaw}` };
    }
    case "remember": {
      const journal = service.getJournalService?.();
      if (!journal) return { success: false, message: "journal unavailable" };
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
    default: {
      const _exhaustive: never = op;
      return { success: false, message: `unknown op ${String(_exhaustive)}` };
    }
  }
}

export const scapeAction: Action = {
  name: "SCAPE",
  description:
    "Drive the 'scape (xRSPS) game agent. Pick one op: walk_to (x,z,run?), attack (npcId), chat_public (message), eat (item?), drop (item), set_goal (title,notes?), complete_goal (status?,goalId?,notes?), remember (notes,kind?,weight?). Returns success and a short status message; the autonomous loop already handles its own dispatch — this is the planner-facing surface.",
  descriptionCompressed:
    "scape ops: walk_to|attack|chat_public|eat|drop|set_goal|complete_goal|remember",
  contexts: ["game", "automation", "world", "state", "messaging"],
  roleGate: { minRole: "ADMIN" },
  similes: [
    "SCAPE_WALK_TO",
    "MOVE_TO",
    "GO_TO",
    "TRAVEL_TO",
    "HEAD_TO",
    "ATTACK_NPC",
    "FIGHT_NPC",
    "KILL_NPC",
    "ENGAGE",
    "CHAT_PUBLIC",
    "SAY",
    "SPEAK",
    "TALK",
    "BROADCAST",
    "JOURNAL",
    "INVENTORY",
    "SET_GOAL",
    "COMPLETE_GOAL",
    "REMEMBER",
    "EAT_FOOD",
    "DROP_ITEM",
  ],
  examples: [],
  parameters: [
    {
      name: "subaction",
      description: "Operation to run.",
      descriptionCompressed: "Op.",
      required: true,
      schema: { type: "string", enum: SCAPE_OPS as string[] },
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
    ) as ScapeGameService | null;
    if (!service) {
      const text = "'scape game service not available.";
      callback?.({ text, action: "SCAPE" });
      return { success: false, text };
    }

    const params = {
      ...paramsFromText(resolveActionText(message)),
      ...paramsFromOptions(options),
    };
    const op = normalizeOp(
      params.op ?? params.subaction ?? params.actionType ?? params.type,
    );
    if (!op) {
      const text = `SCAPE requires a valid op: one of ${SCAPE_OPS.join("|")}.`;
      callback?.({ text, action: "SCAPE" });
      return { success: false, text };
    }

    try {
      const result = await Promise.race([
        dispatchOp(service, op, params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("scape op timed out")), TIMEOUT_MS),
        ),
      ]);
      const text = (
        result.message ?? (result.success ? "ok" : "failed")
      ).slice(0, 2000);
      callback?.({ text, action: "SCAPE" });
      return { success: result.success, text };
    } catch (error) {
      const errText = error instanceof Error ? error.message : "unknown failure";
      const text = `${op} failed: ${errText}`;
      callback?.({ text, action: "SCAPE" });
      return { success: false, text, error: errText, data: { op } };
    }
  },
};
