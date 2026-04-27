/**
 * Counter app plugin — exposes INCREMENT, DECREMENT, GET_COUNT, RESET_COUNT
 * actions backed by a tiny file-backed store. Used as the e2e fixture for
 * APP create / load / unload through the unified APP action.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import { CounterStore } from "./state.js";

const APP_NAME = "app-counter";

export interface CounterActionDeps {
  store?: CounterStore;
}

function readDelta(options: Record<string, unknown> | undefined): number {
  if (!options) return 1;
  const raw = options.by ?? options.delta ?? options.amount;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

export function createIncrementAction(deps: CounterActionDeps = {}): Action {
  const store = deps.store ?? new CounterStore();
  return {
    name: "INCREMENT_COUNTER",
    similes: ["BUMP_COUNTER", "ADD_TO_COUNTER", "COUNTER_PLUS"],
    description: `Increment the ${APP_NAME} counter by an integer (default 1).`,
    examples: [],
    validate: async (_runtime, message) => {
      const text = (message?.content?.text ?? "").toLowerCase();
      return /\b(increment|bump|raise|increase|\+\+|add\s+to)\b.*\bcounter\b/.test(
        text,
      );
    },
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      options: Record<string, unknown> | undefined,
      callback: HandlerCallback | undefined,
    ): Promise<ActionResult> => {
      const next = store.increment(readDelta(options));
      const text = `Counter is now ${next}.`;
      await callback?.({ text });
      return { success: true, text, data: { count: next } };
    },
  };
}

export function createDecrementAction(deps: CounterActionDeps = {}): Action {
  const store = deps.store ?? new CounterStore();
  return {
    name: "DECREMENT_COUNTER",
    similes: ["LOWER_COUNTER", "SUBTRACT_FROM_COUNTER", "COUNTER_MINUS"],
    description: `Decrement the ${APP_NAME} counter by an integer (default 1).`,
    examples: [],
    validate: async (_runtime, message) => {
      const text = (message?.content?.text ?? "").toLowerCase();
      return /\b(decrement|lower|reduce|decrease|--|subtract\s+from)\b.*\bcounter\b/.test(
        text,
      );
    },
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      options: Record<string, unknown> | undefined,
      callback: HandlerCallback | undefined,
    ): Promise<ActionResult> => {
      const next = store.decrement(readDelta(options));
      const text = `Counter is now ${next}.`;
      await callback?.({ text });
      return { success: true, text, data: { count: next } };
    },
  };
}

export function createGetCountAction(deps: CounterActionDeps = {}): Action {
  const store = deps.store ?? new CounterStore();
  return {
    name: "GET_COUNTER",
    similes: ["READ_COUNTER", "SHOW_COUNTER", "COUNTER_VALUE"],
    description: `Read the current value of the ${APP_NAME} counter.`,
    examples: [],
    validate: async (_runtime, message) => {
      const text = (message?.content?.text ?? "").toLowerCase();
      return /\b(get|show|read|what).*\bcounter\b/.test(text);
    },
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback: HandlerCallback | undefined,
    ): Promise<ActionResult> => {
      const value = store.get();
      const text = `Counter is ${value}.`;
      await callback?.({ text });
      return { success: true, text, data: { count: value } };
    },
  };
}

export function createResetCountAction(deps: CounterActionDeps = {}): Action {
  const store = deps.store ?? new CounterStore();
  return {
    name: "RESET_COUNTER",
    similes: ["ZERO_COUNTER", "CLEAR_COUNTER"],
    description: `Reset the ${APP_NAME} counter to 0.`,
    examples: [],
    validate: async (_runtime, message) => {
      const text = (message?.content?.text ?? "").toLowerCase();
      return /\b(reset|clear|zero)\b.*\bcounter\b/.test(text);
    },
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback: HandlerCallback | undefined,
    ): Promise<ActionResult> => {
      const next = store.reset();
      const text = `Counter reset to ${next}.`;
      await callback?.({ text });
      return { success: true, text, data: { count: next } };
    },
  };
}

export function createCounterPlugin(deps: CounterActionDeps = {}): Plugin {
  const store = deps.store ?? new CounterStore();
  return {
    name: APP_NAME,
    description: `Runtime plugin for the ${APP_NAME} app — increment / decrement / read / reset a single integer counter persisted to disk.`,
    actions: [
      createIncrementAction({ store }),
      createDecrementAction({ store }),
      createGetCountAction({ store }),
      createResetCountAction({ store }),
    ],
  };
}

const plugin: Plugin = createCounterPlugin();

export default plugin;
export { plugin };
