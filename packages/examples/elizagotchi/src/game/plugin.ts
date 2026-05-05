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

function makeGameAction(params: {
  name: string;
  description: string;
  similes: string[];
  animation: AnimationType;
  run: (
    runtime: IAgentRuntime,
    options?: HandlerOptions,
  ) => {
    petState: PetState;
    message?: string;
    success: boolean;
  };
}): ElizaAction {
  return {
    name: params.name,
    description: params.description,
    similes: params.similes,
    validate: async (_runtime: IAgentRuntime, message) => {
      // Validate that this is an elizagotchi-related action by checking message content
      const text = (message?.content?.text ?? "").toLowerCase();
      const actionKeywords = params.similes.map((s) => s.toLowerCase());

      // Check if any simile keyword is present in the message
      const hasRelevantKeyword = actionKeywords.some((kw) => text.includes(kw));

      // Also check for pet/game context words
      const hasPetContext =
        text.includes("pet") ||
        text.includes("elizagotchi") ||
        text.includes("tamagotchi") ||
        text.includes("game");

      return hasRelevantKeyword || hasPetContext;
    },
    handler: async (
      runtime: IAgentRuntime,
      _message,
      _state,
      options,
      callback,
    ): Promise<ElizaActionResult> => {
      const result = params.run(runtime, options);
      await publishState(runtime, result.petState, callback, {
        message: result.message,
        animation: params.animation,
      });
      return {
        success: result.success,
        text: result.message,
        data: { actionName: params.name, petState: result.petState },
      };
    },
  };
}

// ============================================================================
// elizaOS actions
// ============================================================================

const tickAction: ElizaAction = {
  name: "ELIZAGOTCHI_TICK",
  description: "Advance the pet simulation based on elapsed time.",
  similes: ["tick", "update", "step", "__tick__"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text === "__tick__" || text.includes("tick") || text.includes("update")
    );
  },
  handler: async (runtime, _message, _state, _options, callback) => {
    const current = loadPetState(runtime);
    const updated = applyTimeUpdate(current);
    savePetState(runtime, updated);
    await publishState(runtime, updated, callback, {
      kind: "elizagotchi_tick",
    });
    return { success: true, data: { actionName: "ELIZAGOTCHI_TICK" } };
  },
};

const statusAction: ElizaAction = {
  name: "ELIZAGOTCHI_STATUS",
  description: "Get a full status readout of the pet (with stats).",
  similes: ["status", "stats", "info", "health"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text.includes("status") ||
      text.includes("stats") ||
      text.includes("health") ||
      text.includes("how is")
    );
  },
  handler: async (runtime, _message, _state, _options, callback) => {
    const current = loadPetState(runtime);
    const updated = applyTimeUpdate(current);
    savePetState(runtime, updated);
    await publishState(runtime, updated, callback, {
      kind: "elizagotchi_status",
      message: formatStatus(updated),
      animation: "idle",
    });
    return {
      success: true,
      text: formatStatus(updated),
      data: { actionName: "ELIZAGOTCHI_STATUS", petState: updated },
    };
  },
};

const helpAction: ElizaAction = {
  name: "ELIZAGOTCHI_HELP",
  description: "Show available Elizagotchi commands.",
  similes: ["help", "commands", "options"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text.includes("help") ||
      text.includes("commands") ||
      text.includes("what can")
    );
  },
  handler: async (_runtime, _message, _state, _options, callback) => {
    if (callback) {
      await callback({ type: "elizagotchi_help", text: getHelp() });
    }
    return {
      success: true,
      text: getHelp(),
      data: { actionName: "ELIZAGOTCHI_HELP" },
    };
  },
};

const resetAction: ElizaAction = {
  name: "ELIZAGOTCHI_RESET",
  description: "Reset the game with a new pet (optionally named).",
  similes: ["reset", "restart", "new", "again", "new pet"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text.includes("reset") ||
      text.includes("restart") ||
      text.includes("new pet") ||
      text.includes("start over")
    );
  },
  parameters: [
    {
      name: "name",
      description: "Name for the new pet",
      required: false,
      schema: { type: "string" },
    },
  ],
  handler: async (runtime, _message, _state, options, callback) => {
    const name = getStringParam(options, "name") || "Elizagotchi";
    const fresh = createNewPet(name);
    savePetState(runtime, fresh);
    await publishState(runtime, fresh, callback, {
      kind: "elizagotchi_reset",
      message: `🥚 ${name} appeared!`,
      animation: "hatching",
    });
    return {
      success: true,
      text: `🥚 ${name} appeared!`,
      data: { actionName: "ELIZAGOTCHI_RESET", petState: fresh },
    };
  },
};

const exportAction: ElizaAction = {
  name: "ELIZAGOTCHI_EXPORT",
  description: "Export the current pet save data as JSON.",
  similes: ["export", "backup", "save file"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text.includes("export") ||
      text.includes("backup") ||
      text.includes("save file") ||
      text.includes("download")
    );
  },
  handler: async (runtime, _message, _state, _options, callback) => {
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
      data: { actionName: "ELIZAGOTCHI_EXPORT", saveData },
    };
  },
};

const importAction: ElizaAction = {
  name: "ELIZAGOTCHI_IMPORT",
  description: "Import a pet save JSON and replace the current pet state.",
  similes: ["import", "load save"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text.includes("import") ||
      text.includes("load save") ||
      text.startsWith("__import__:")
    );
  },
  parameters: [
    {
      name: "saveJson",
      description: "The JSON string of the save file",
      required: true,
      schema: { type: "string" },
    },
  ],
  handler: async (runtime, _message, _state, options, callback) => {
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

      // On import, reset lastUpdate so decay starts from "now" in this session.
      const restored: PetState = {
        ...(pet as PetState),
        lastUpdate: Date.now(),
      };

      savePetState(runtime, restored);
      await publishState(runtime, restored, callback, {
        kind: "elizagotchi_import",
        message: `📥 Loaded ${restored.name}!`,
        animation: "happy",
      });
      return {
        success: true,
        text: `📥 Loaded ${restored.name}!`,
        data: { actionName: "ELIZAGOTCHI_IMPORT", petState: restored },
      };
    } catch {
      return { success: false, error: "Invalid save JSON" };
    }
  },
};

const renameAction: ElizaAction = {
  name: "ELIZAGOTCHI_NAME",
  description: "Rename your pet.",
  similes: ["name", "call", "rename"],
  validate: async (_runtime: IAgentRuntime, message) => {
    const text = (message?.content?.text ?? "").toLowerCase();
    return (
      text.includes("name") ||
      text.includes("rename") ||
      text.includes("call it") ||
      text.includes("call my pet")
    );
  },
  parameters: [
    {
      name: "name",
      description: "The new pet name",
      required: true,
      schema: { type: "string" },
    },
  ],
  handler: async (runtime, _message, _state, options, callback) => {
    const newName = getStringParam(options, "name");
    const current = loadPetState(runtime);
    const updatedBase = applyTimeUpdate(current);
    const updated = newName ? { ...updatedBase, name: newName } : updatedBase;
    savePetState(runtime, updated);
    await publishState(runtime, updated, callback, {
      kind: "elizagotchi_name",
      message: newName
        ? `Your pet is now named "${newName}"!`
        : "What would you like to name your pet?",
      animation: "happy",
    });
    return {
      success: true,
      text: newName
        ? `Your pet is now named "${newName}"!`
        : "What would you like to name your pet?",
      data: { actionName: "ELIZAGOTCHI_NAME", petState: updated },
    };
  },
};

const feedAction = makeGameAction({
  name: "ELIZAGOTCHI_FEED",
  description: "Feed the pet to reduce hunger.",
  similes: ["feed", "eat", "food", "meal", "snack"],
  animation: "eating",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "feed");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const playAction = makeGameAction({
  name: "ELIZAGOTCHI_PLAY",
  description: "Play with the pet to increase happiness.",
  similes: ["play", "game", "fun", "toy"],
  animation: "playing",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "play");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const cleanAction = makeGameAction({
  name: "ELIZAGOTCHI_CLEAN",
  description: "Clean up messes and improve cleanliness.",
  similes: ["clean", "wash", "bath", "poop", "dirty"],
  animation: "cleaning",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "clean");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const sleepAction = makeGameAction({
  name: "ELIZAGOTCHI_SLEEP",
  description: "Put the pet to sleep (requires lights off).",
  similes: ["sleep", "rest", "nap", "bed"],
  animation: "sleeping",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "sleep");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const medicineAction = makeGameAction({
  name: "ELIZAGOTCHI_MEDICINE",
  description: "Give medicine when the pet is sick.",
  similes: ["medicine", "heal", "cure", "doctor", "pill"],
  animation: "happy",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "medicine");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const disciplineAction = makeGameAction({
  name: "ELIZAGOTCHI_DISCIPLINE",
  description: "Discipline the pet to improve behavior.",
  similes: ["discipline", "scold", "punish", "train", "no", "bad"],
  animation: "sad",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "discipline");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const lightToggleAction = makeGameAction({
  name: "ELIZAGOTCHI_LIGHT_TOGGLE",
  description: "Toggle the lights on/off (affects sleeping).",
  similes: ["light", "lamp", "dark", "bright", "lights"],
  animation: "idle",
  run: (runtime) => {
    const current = loadPetState(runtime);
    const base = applyTimeUpdate(current);
    const result = performAction(base, "light_toggle");
    savePetState(runtime, result.newState);
    return {
      petState: result.newState,
      message: result.message,
      success: result.success,
    };
  },
});

const allActions: ElizaAction[] = [
  tickAction,
  statusAction,
  helpAction,
  resetAction,
  exportAction,
  importAction,
  renameAction,
  feedAction,
  playAction,
  cleanAction,
  sleepAction,
  medicineAction,
  disciplineAction,
  lightToggleAction,
];

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
  if (!cmd) return { actionName: "ELIZAGOTCHI_HELP" };

  switch (cmd.action) {
    case "status":
      return { actionName: "ELIZAGOTCHI_STATUS" };
    case "help":
      return { actionName: "ELIZAGOTCHI_HELP" };
    case "reset":
      return { actionName: "ELIZAGOTCHI_RESET" };
    case "name":
      return cmd.parameter
        ? { actionName: "ELIZAGOTCHI_NAME", params: { name: cmd.parameter } }
        : { actionName: "ELIZAGOTCHI_NAME" };
    default: {
      const action = cmd.action as GameAction;
      const mapping: Record<GameAction, string> = {
        feed: "ELIZAGOTCHI_FEED",
        play: "ELIZAGOTCHI_PLAY",
        clean: "ELIZAGOTCHI_CLEAN",
        sleep: "ELIZAGOTCHI_SLEEP",
        medicine: "ELIZAGOTCHI_MEDICINE",
        discipline: "ELIZAGOTCHI_DISCIPLINE",
        light_toggle: "ELIZAGOTCHI_LIGHT_TOGGLE",
      };
      return { actionName: mapping[action] };
    }
  }
}

function toXmlResponse(params: {
  thought: string;
  actionName: string;
  text?: string;
  providers?: string[];
  actionParams?: Record<string, string>;
}): string {
  const providers = params.providers ?? [];

  const paramsXml =
    params.actionParams && Object.keys(params.actionParams).length > 0
      ? `<params>${Object.entries(params.actionParams)
          .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
          .join("")}</params>`
      : "";

  return (
    `<thought>${escapeXml(params.thought)}</thought>` +
    `<actions>${escapeXml(params.actionName)}</actions>` +
    (providers.length > 0
      ? `<providers>${providers.map(escapeXml).join("</providers><providers>")}</providers>`
      : "") +
    `<text>${escapeXml(params.text ?? "")}</text>` +
    paramsXml
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function elizagotchiModelHandler(
  _runtime: IAgentRuntime,
  params: ModelParamsMap[typeof ModelType.TEXT_LARGE],
): Promise<string> {
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  const userText = extractUserTextFromPrompt(prompt);

  // Allow a dedicated tick command that doesn't require natural language parsing
  if (userText === "__tick__") {
    return toXmlResponse({
      thought: "Advance simulation tick",
      actionName: "ELIZAGOTCHI_TICK",
    });
  }

  if (userText === "__export__") {
    return toXmlResponse({
      thought: "Export save data",
      actionName: "ELIZAGOTCHI_EXPORT",
    });
  }

  if (userText.startsWith("__import__:")) {
    const encoded = userText.slice("__import__:".length);
    const saveJson = decodeURIComponent(encoded);
    return toXmlResponse({
      thought: "Import save data",
      actionName: "ELIZAGOTCHI_IMPORT",
      actionParams: { saveJson },
    });
  }

  if (userText.startsWith("__reset__:")) {
    const encoded = userText.slice("__reset__:".length);
    const name = decodeURIComponent(encoded);
    return toXmlResponse({
      thought: "Reset with chosen name",
      actionName: "ELIZAGOTCHI_RESET",
      actionParams: { name },
    });
  }

  const cmd = parseCommand(userText) as GameCommand | null;
  const resolved = actionNameFromCommand(cmd);

  return toXmlResponse({
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
