/**
 * Elizagotchi elizaOS Plugin
 *
 * Goal: make the AgentRuntime the source of truth.
 * - Pet state is stored inside the agent runtime (settings via localdb/sql adapter)
 * - All mutations happen via runtime actions (feed/play/clean/...)
 * - The UI becomes a thin client: sends intents, renders state snapshots
 */

import {
  type AgentRuntime,
  type Action as ElizaAction,
  type ActionResult as ElizaActionResult,
  type EventPayload,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type ModelParamsMap,
  ModelType,
  type Plugin,
  Service,
} from "@elizaos/core";
import {
  checkHatch,
  createNewPet,
  formatStatus,
  getHelp,
  parseCommand,
  performAction,
  tickUpdate,
} from "./engine";
import type {
  AnimationType,
  Action as GameAction,
  GameCommand,
  PetState,
  SaveData,
} from "./types";

// ============================================================================
// Storage keys (agent-internal)
// ============================================================================

const PET_STATE_SETTING_KEY = "ELIZAGOTCHI_PET_STATE_JSON";
const SAVE_VERSION = 1 as const;
const ELIZAGOTCHI_CONTEXTS = ["game"] as const;
const ELIZAGOTCHI_CONTEXT_GATE = { anyOf: [...ELIZAGOTCHI_CONTEXTS] };
const ELIZAGOTCHI_CONTEXT_TERMS = [
  "pet",
  "elizagotchi",
  "tamagotchi",
  "virtual pet",
  "game",
  "mascota",
  "mascota virtual",
  "animal de compagnie",
  "animal virtuel",
  "haustier",
  "virtuelles haustier",
  "宠物",
  "电子宠物",
  "たまごっち",
  "ペット",
  "애완동물",
  "다마고치",
  "alagang hayop",
  "thú cưng",
  "thu cung",
];

function getMessageText(
  message: { content?: { text?: unknown } } | undefined,
): string {
  return typeof message?.content?.text === "string"
    ? message.content.text.toLowerCase()
    : "";
}

function normalizeContextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => (typeof item === "string" ? [item.toLowerCase()] : []))
    .filter(Boolean);
}

function hasSelectedElizagotchiContext(
  message: unknown,
  state: unknown,
): boolean {
  const stateValues =
    state && typeof state === "object" && "values" in state
      ? (state as { values?: Record<string, unknown> }).values
      : undefined;
  const messageContent =
    message && typeof message === "object" && "content" in message
      ? (message as { content?: Record<string, unknown> }).content
      : undefined;
  const selectedContexts = [
    ...normalizeContextList(stateValues?.activeContexts),
    ...normalizeContextList(stateValues?.selectedContexts),
    ...normalizeContextList(messageContent?.activeContexts),
    ...normalizeContextList(messageContent?.selectedContexts),
    ...normalizeContextList(messageContent?.contexts),
  ];
  return selectedContexts.some((context) =>
    ELIZAGOTCHI_CONTEXTS.includes(context as "game"),
  );
}

function hasElizagotchiSignal(
  message: { content?: { text?: unknown } } | undefined,
  state: unknown,
  terms: readonly string[],
): boolean {
  if (hasSelectedElizagotchiContext(message, state)) return true;
  const text = getMessageText(message);
  return [...terms, ...ELIZAGOTCHI_CONTEXT_TERMS].some((term) =>
    text.includes(term.toLowerCase()),
  );
}

// ============================================================================
// Custom runtime events (in-process)
// ============================================================================

export const ELIZAGOTCHI_STATE_UPDATED_EVENT = "ELIZAGOTCHI_STATE_UPDATED";

export type ElizagotchiStateUpdatedPayload = EventPayload & {
  petState: PetState;
  message?: string;
  animation?: AnimationType;
};

// ============================================================================
// Persistence helpers (store state inside agent)
// ============================================================================

function loadPetState(runtime: IAgentRuntime): PetState {
  const raw = runtime.getSetting(PET_STATE_SETTING_KEY);
  if (typeof raw !== "string" || raw.trim() === "") {
    return createNewPet("Elizagotchi");
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PetState>;
    if (!parsed || typeof parsed !== "object") {
      return createNewPet("Elizagotchi");
    }

    // Minimal shape checks to avoid crashing on corrupted storage
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.stage !== "string" ||
      typeof parsed.mood !== "string" ||
      !parsed.stats ||
      typeof parsed.birthTime !== "number" ||
      typeof parsed.lastUpdate !== "number"
    ) {
      return createNewPet("Elizagotchi");
    }

    return parsed as PetState;
  } catch {
    return createNewPet("Elizagotchi");
  }
}

function savePetState(runtime: IAgentRuntime, petState: PetState): void {
  runtime.setSetting(PET_STATE_SETTING_KEY, JSON.stringify(petState));
}

export function buildSaveData(petState: PetState): SaveData {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    pet: petState,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Core game update (time + egg hatch)
// ============================================================================

function applyTimeUpdate(state: PetState): PetState {
  // Hatch check first (egg has no decay)
  if (state.stage === "egg") {
    const hatchResult = checkHatch(state);
    if (hatchResult.hatched) {
      return hatchResult.newState;
    }
  }
  return tickUpdate(state);
}

// ============================================================================
// Action helpers
// ============================================================================

function getStringParam(
  options: HandlerOptions | undefined,
  key: string,
): string | null {
  const params = options?.parameters as Record<string, string> | undefined;
  if (!params) return null;
  const value = params[key];
  return typeof value === "string" ? value : null;
}

async function publishState(
  runtime: IAgentRuntime,
  petState: PetState,
  callback: HandlerCallback | undefined,
  payload: { message?: string; animation?: AnimationType; kind?: string },
): Promise<void> {
  const kind = payload.kind ?? "elizagotchi_state";

  emitStateEvent(runtime, petState, {
    message: payload.message,
    animation: payload.animation,
  });

  if (callback) {
    await callback({
      type: kind,
      text: payload.message,
      petStateJson: JSON.stringify(petState),
      animation: payload.animation,
    });
  }
}

function emitStateEvent(
  runtime: IAgentRuntime,
  petState: PetState,
  payload: { message?: string; animation?: AnimationType },
): void {
  (runtime as AgentRuntime).emit(ELIZAGOTCHI_STATE_UPDATED_EVENT, {
    runtime,
    source: "elizagotchi",
    petState,
    message: payload.message,
    animation: payload.animation,
  } as ElizagotchiStateUpdatedPayload);
}

type ElizagotchiOp =
  | GameAction
  | "tick"
  | "status"
  | "help"
  | "reset"
  | "export"
  | "import"
  | "name";

const ELIZAGOTCHI_OPS = [
  "tick",
  "status",
  "help",
  "reset",
  "export",
  "import",
  "name",
  "feed",
  "play",
  "clean",
  "sleep",
  "medicine",
  "discipline",
  "light_toggle",
] as const satisfies readonly ElizagotchiOp[];

const ELIZAGOTCHI_ACTION_ALIASES: Partial<Record<string, ElizagotchiOp>> = {
  elizagotchi_tick: "tick",
  update: "tick",
  step: "tick",
  __tick__: "tick",
  elizagotchi_status: "status",
  stats: "status",
  info: "status",
  health: "status",
  elizagotchi_help: "help",
  commands: "help",
  options: "help",
  elizagotchi_reset: "reset",
  restart: "reset",
  new: "reset",
  new_pet: "reset",
  elizagotchi_export: "export",
  backup: "export",
  save_file: "export",
  elizagotchi_import: "import",
  load_save: "import",
  elizagotchi_name: "name",
  rename: "name",
  call: "name",
  elizagotchi_feed: "feed",
  eat: "feed",
  food: "feed",
  meal: "feed",
  snack: "feed",
  elizagotchi_play: "play",
  game: "play",
  fun: "play",
  toy: "play",
  elizagotchi_clean: "clean",
  wash: "clean",
  bath: "clean",
  dirty: "clean",
  elizagotchi_sleep: "sleep",
  rest: "sleep",
  nap: "sleep",
  bed: "sleep",
  elizagotchi_medicine: "medicine",
  heal: "medicine",
  cure: "medicine",
  doctor: "medicine",
  pill: "medicine",
  elizagotchi_discipline: "discipline",
  scold: "discipline",
  punish: "discipline",
  train: "discipline",
  elizagotchi_light_toggle: "light_toggle",
  light: "light_toggle",
  lights: "light_toggle",
  lamp: "light_toggle",
  dark: "light_toggle",
  bright: "light_toggle",
};

const ELIZAGOTCHI_SIMILES = [
  "ELIZAGOTCHI_TICK",
  "ELIZAGOTCHI_STATUS",
  "ELIZAGOTCHI_HELP",
  "ELIZAGOTCHI_RESET",
  "ELIZAGOTCHI_EXPORT",
  "ELIZAGOTCHI_IMPORT",
  "ELIZAGOTCHI_NAME",
  "ELIZAGOTCHI_FEED",
  "ELIZAGOTCHI_PLAY",
  "ELIZAGOTCHI_CLEAN",
  "ELIZAGOTCHI_SLEEP",
  "ELIZAGOTCHI_MEDICINE",
  "ELIZAGOTCHI_DISCIPLINE",
  "ELIZAGOTCHI_LIGHT_TOGGLE",
  ...ELIZAGOTCHI_OPS,
  "update",
  "step",
  "__tick__",
  "stats",
  "info",
  "health",
  "commands",
  "options",
  "restart",
  "new pet",
  "backup",
  "save file",
  "load save",
  "rename",
  "eat",
  "food",
  "meal",
  "snack",
  "game",
  "fun",
  "toy",
  "wash",
  "bath",
  "poop",
  "dirty",
  "rest",
  "nap",
  "bed",
  "heal",
  "cure",
  "doctor",
  "pill",
  "scold",
  "punish",
  "train",
  "light",
  "lamp",
  "dark",
  "bright",
  "actualizar",
  "estado",
  "ayuda",
  "reiniciar",
  "导出",
  "导入",
  "名前",
  "アップデート",
  "상태",
  "giup",
  "cap nhat",
];

function inferElizagotchiOpFromMessage(
  text: string,
): ElizagotchiOp | undefined {
  if (text === "__tick__") return "tick";
  if (text === "__export__") return "export";
  if (text.startsWith("__import__:")) return "import";
  if (text.startsWith("__reset__:")) return "reset";
  const command = parseCommand(text);
  return command?.action;
}

function normalizeElizagotchiOp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : undefined;
}

function readElizagotchiOpParam(
  parameters: Record<string, unknown> | undefined,
): ElizagotchiOp | undefined {
  const allowed = new Set<string>(ELIZAGOTCHI_OPS);
  // Canonical discriminator is "action" per the post-consolidation taxonomy
  // (docs/audits/action-structure-audit-2026-05-10.md). "op" and "subaction"
  // remain accepted as legacy aliases for older callers.
  for (const key of ["action", "op", "subaction"]) {
    const normalized = normalizeElizagotchiOp(parameters?.[key]);
    if (!normalized) continue;
    const aliased = ELIZAGOTCHI_ACTION_ALIASES[normalized];
    if (aliased) return aliased;
    if (allowed.has(normalized)) return normalized as ElizagotchiOp;
    return undefined;
  }
  return undefined;
}

function resolveElizagotchiOp(
  message: { content?: { text?: unknown } } | undefined,
  options: HandlerOptions | undefined,
): ElizagotchiOp | undefined {
  const parameters = options?.parameters as Record<string, unknown> | undefined;
  return (
    readElizagotchiOpParam(parameters) ??
    inferElizagotchiOpFromMessage(getMessageText(message))
  );
}

function actionNameForOp(op: ElizagotchiOp): string {
  return `ELIZAGOTCHI_${op.toUpperCase()}`;
}

async function runGameMutation(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  action: GameAction,
  animation: AnimationType,
): Promise<ElizaActionResult> {
  const current = loadPetState(runtime);
  const base = applyTimeUpdate(current);
  const result = performAction(base, action);
  savePetState(runtime, result.newState);
  await publishState(runtime, result.newState, callback, {
    message: result.message,
    animation,
  });
  return {
    success: result.success,
    text: result.message,
    data: {
      actionName: "ELIZAGOTCHI",
      legacyActionName: actionNameForOp(action),
      action,
      op: action,
      petState: result.newState,
    },
  };
}

// ============================================================================
// elizaOS action
// ============================================================================

const elizagotchiAction: ElizaAction = {
  name: "ELIZAGOTCHI",
  description:
    "Play the Elizagotchi virtual pet game. Use `action` to tick, check status, show help, reset, export/import saves, rename, feed, play, clean, sleep, give medicine, discipline, or toggle lights.",
  descriptionCompressed:
    "Elizagotchi virtual pet. action=tick/status/help/reset/export/import/name/feed/play/clean/sleep/medicine/discipline/light_toggle.",
  contexts: [...ELIZAGOTCHI_CONTEXTS],
  contextGate: ELIZAGOTCHI_CONTEXT_GATE,
  roleGate: { minRole: "USER" },
  similes: ELIZAGOTCHI_SIMILES,
  validate: async (_runtime: IAgentRuntime, message, state) => {
    return hasElizagotchiSignal(message, state, ELIZAGOTCHI_SIMILES);
  },
  parameters: [
    {
      name: "action",
      description:
        "Elizagotchi operation to run. Canonical discriminator (legacy aliases: op, subaction).",
      required: false,
      schema: {
        type: "string",
        enum: [...ELIZAGOTCHI_OPS],
      },
    },
    {
      name: "op",
      description: "Legacy alias for `action`. Prefer `action`.",
      required: false,
      schema: {
        type: "string",
        enum: [...ELIZAGOTCHI_OPS],
      },
    },
    {
      name: "name",
      description: "Pet name for reset or rename operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "saveJson",
      description: "Save JSON for the import operation.",
      required: false,
      schema: { type: "string" },
    },
  ],
  handler: async (runtime, message, _state, options, callback) => {
    const op = resolveElizagotchiOp(message, options);
    if (!op) {
      if (callback) {
        await callback({ type: "elizagotchi_help", text: getHelp() });
      }
      return {
        success: true,
        text: getHelp(),
        data: { actionName: "ELIZAGOTCHI", action: "help", op: "help" },
      };
    }

    if (op === "tick") {
      const current = loadPetState(runtime);
      const updated = applyTimeUpdate(current);
      savePetState(runtime, updated);
      await publishState(runtime, updated, callback, {
        kind: "elizagotchi_tick",
      });
      return {
        success: true,
        data: {
          actionName: "ELIZAGOTCHI",
          legacyActionName: "ELIZAGOTCHI_TICK",
          action: op,
          op,
        },
      };
    }

    if (op === "status") {
      const current = loadPetState(runtime);
      const updated = applyTimeUpdate(current);
      savePetState(runtime, updated);
      const text = formatStatus(updated);
      await publishState(runtime, updated, callback, {
        kind: "elizagotchi_status",
        message: text,
        animation: "idle",
      });
      return {
        success: true,
        text,
        data: {
          actionName: "ELIZAGOTCHI",
          legacyActionName: "ELIZAGOTCHI_STATUS",
          action: op,
          op,
          petState: updated,
        },
      };
    }

    if (op === "help") {
      if (callback) {
        await callback({ type: "elizagotchi_help", text: getHelp() });
      }
      return {
        success: true,
        text: getHelp(),
        data: {
          actionName: "ELIZAGOTCHI",
          legacyActionName: "ELIZAGOTCHI_HELP",
          action: op,
          op,
        },
      };
    }

    if (op === "reset") {
      const name = getStringParam(options, "name") || "Elizagotchi";
      const fresh = createNewPet(name);
      savePetState(runtime, fresh);
      const text = `🥚 ${name} appeared!`;
      await publishState(runtime, fresh, callback, {
        kind: "elizagotchi_reset",
        message: text,
        animation: "hatching",
      });
      return {
        success: true,
        text,
        data: {
          actionName: "ELIZAGOTCHI",
          legacyActionName: "ELIZAGOTCHI_RESET",
          action: op,
          op,
          petState: fresh,
        },
      };
    }

    if (op === "export") {
      const petState = loadPetState(runtime);
      const saveData = buildSaveData(petState);
      if (callback) {
        await callback({
          type: "elizagotchi_export",
          saveDataJson: JSON.stringify(saveData),
        });
      }
      return {
        success: true,
        data: {
          actionName: "ELIZAGOTCHI",
          legacyActionName: "ELIZAGOTCHI_EXPORT",
          action: op,
          op,
          saveData,
        },
      };
    }

    if (op === "import") {
      const saveJson = getStringParam(options, "saveJson");
      if (!saveJson) {
        return { success: false, error: "Missing saveJson parameter" };
      }

      try {
        const parsed = JSON.parse(saveJson) as Partial<SaveData> & {
          pet?: Partial<PetState>;
        };
        const pet = parsed.pet;
        if (
          !pet ||
          typeof pet.name !== "string" ||
          typeof pet.stage !== "string" ||
          typeof pet.mood !== "string" ||
          !pet.stats ||
          typeof pet.birthTime !== "number" ||
          typeof pet.lastUpdate !== "number"
        ) {
          return { success: false, error: "Invalid save file" };
        }

        const restored: PetState = {
          ...(pet as PetState),
          lastUpdate: Date.now(),
        };
        savePetState(runtime, restored);
        const text = `📥 Loaded ${restored.name}!`;
        await publishState(runtime, restored, callback, {
          kind: "elizagotchi_import",
          message: text,
          animation: "happy",
        });
        return {
          success: true,
          text,
          data: {
            actionName: "ELIZAGOTCHI",
            legacyActionName: "ELIZAGOTCHI_IMPORT",
            action: op,
            op,
            petState: restored,
          },
        };
      } catch {
        return { success: false, error: "Invalid save JSON" };
      }
    }

    if (op === "name") {
      const newName = getStringParam(options, "name");
      const current = loadPetState(runtime);
      const updatedBase = applyTimeUpdate(current);
      const updated = newName ? { ...updatedBase, name: newName } : updatedBase;
      savePetState(runtime, updated);
      const text = newName
        ? `Your pet is now named "${newName}"!`
        : "What would you like to name your pet?";
      await publishState(runtime, updated, callback, {
        kind: "elizagotchi_name",
        message: text,
        animation: "happy",
      });
      return {
        success: true,
        text,
        data: {
          actionName: "ELIZAGOTCHI",
          legacyActionName: "ELIZAGOTCHI_NAME",
          action: op,
          op,
          petState: updated,
        },
      };
    }

    const animationByAction: Record<GameAction, AnimationType> = {
      feed: "eating",
      play: "playing",
      clean: "cleaning",
      sleep: "sleeping",
      medicine: "happy",
      discipline: "sad",
      light_toggle: "idle",
    };
    return runGameMutation(runtime, callback, op, animationByAction[op]);
  },
};

const allActions: ElizaAction[] = [elizagotchiAction];

// ============================================================================
// Background tick service (keeps state inside agent, UI subscribes)
// ============================================================================

class ElizagotchiTickService extends Service {
  static serviceType = "elizagotchi_tick";
  capabilityDescription = "Elizagotchi background simulation tick";

  #intervalId: ReturnType<typeof setInterval> | null = null;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new ElizagotchiTickService(runtime);
    service.#start(runtime);
    return service;
  }

  #start(runtime: IAgentRuntime): void {
    // Emit once immediately so UI can render without a manual "status" request
    const current = loadPetState(runtime);
    emitStateEvent(runtime, current, {});

    this.#intervalId = setInterval(() => {
      const state = loadPetState(runtime);
      const updated = applyTimeUpdate(state);
      savePetState(runtime, updated);
      emitStateEvent(runtime, updated, {});
    }, 1000);
  }

  async stop(): Promise<void> {
    if (this.#intervalId) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }
}

// ============================================================================
// Deterministic model handler (no external LLM required)
// ============================================================================

function extractUserTextFromPrompt(prompt: string): string {
  // Bootstrap templates usually include "User:" sections.
  const matches = [...prompt.matchAll(/(?:^|\n)User:\s*(.+?)(?=\n|$)/g)];
  const last = matches.length > 0 ? matches[matches.length - 1] : null;
  const candidate = last?.[1];
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate.trim()
    : prompt.trim();
}

function actionNameFromCommand(cmd: GameCommand | null): {
  actionName: string;
  params?: Record<string, string>;
} {
  if (!cmd) return { actionName: "ELIZAGOTCHI", params: { action: "help" } };

  switch (cmd.action) {
    case "status":
      return { actionName: "ELIZAGOTCHI", params: { action: "status" } };
    case "help":
      return { actionName: "ELIZAGOTCHI", params: { action: "help" } };
    case "reset":
      return { actionName: "ELIZAGOTCHI", params: { action: "reset" } };
    case "name":
      return cmd.parameter
        ? {
            actionName: "ELIZAGOTCHI",
            params: { action: "name", name: cmd.parameter },
          }
        : { actionName: "ELIZAGOTCHI", params: { action: "name" } };
    default: {
      const action = cmd.action as GameAction;
      return { actionName: "ELIZAGOTCHI", params: { action } };
    }
  }
}

function renderToonField(key: string, value: string, indent = ""): string {
  if (value.includes("\n")) {
    return `${indent}${key}:\n${value
      .split(/\r?\n/)
      .map((line) => `${indent}  ${line}`)
      .join("\n")}`;
  }
  return `${indent}${key}: ${value}`;
}

function toToonResponse(params: {
  thought: string;
  actionName: string;
  text?: string;
  providers?: string[];
  actionParams?: Record<string, string>;
}): string {
  const providers = params.providers ?? [];
  const lines = [
    renderToonField("thought", params.thought),
    renderToonField("actions", params.actionName),
  ];
  if (providers.length > 0) {
    lines.push(renderToonField("providers", providers.join(",")));
  }
  lines.push(renderToonField("text", params.text ?? ""));

  if (params.actionParams && Object.keys(params.actionParams).length > 0) {
    lines.push("params:");
    lines.push(`  ${params.actionName}:`);
    for (const [key, value] of Object.entries(params.actionParams)) {
      lines.push(renderToonField(key, value, "    "));
    }
  }

  return lines.join("\n");
}

async function elizagotchiModelHandler(
  _runtime: IAgentRuntime,
  params: ModelParamsMap[typeof ModelType.TEXT_LARGE],
): Promise<string> {
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  const userText = extractUserTextFromPrompt(prompt);

  // Allow a dedicated tick command that doesn't require natural language parsing
  if (userText === "__tick__") {
    return toToonResponse({
      thought: "Advance simulation tick",
      actionName: "ELIZAGOTCHI",
      actionParams: { action: "tick" },
    });
  }

  if (userText === "__export__") {
    return toToonResponse({
      thought: "Export save data",
      actionName: "ELIZAGOTCHI",
      actionParams: { action: "export" },
    });
  }

  if (userText.startsWith("__import__:")) {
    const encoded = userText.slice("__import__:".length);
    const saveJson = decodeURIComponent(encoded);
    return toToonResponse({
      thought: "Import save data",
      actionName: "ELIZAGOTCHI",
      actionParams: { action: "import", saveJson },
    });
  }

  if (userText.startsWith("__reset__:")) {
    const encoded = userText.slice("__reset__:".length);
    const name = decodeURIComponent(encoded);
    return toToonResponse({
      thought: "Reset with chosen name",
      actionName: "ELIZAGOTCHI",
      actionParams: { action: "reset", name },
    });
  }

  const cmd = parseCommand(userText) as GameCommand | null;
  const resolved = actionNameFromCommand(cmd);

  return toToonResponse({
    thought: `Route to ${resolved.actionName}`,
    actionName: resolved.actionName,
    actionParams: resolved.params,
  });
}

// ============================================================================
// Plugin export
// ============================================================================

export const elizagotchiPlugin: Plugin = {
  name: "elizagotchi",
  description:
    "Virtual pet game that stores internal state inside the agent runtime and mutates via actions.",
  priority: 100,
  actions: allActions,
  services: [ElizagotchiTickService],
  models: {
    [ModelType.TEXT_LARGE]: elizagotchiModelHandler,
    [ModelType.TEXT_SMALL]: elizagotchiModelHandler,
  },
};
