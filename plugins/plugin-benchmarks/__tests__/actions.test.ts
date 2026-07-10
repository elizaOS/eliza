/**
 * Exercises every benchmark action family through its production handlers and
 * verifies that promoted actions pin their structural discriminator. The suite
 * is deterministic because these actions are vocabulary adapters, not live
 * benchmark-environment clients.
 */
import type { Action, HandlerOptions, IAgentRuntime, JsonValue, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  benchmarksPlugin,
  osworldAction,
  tauBenchToolAction,
  vendingMachineAction,
  visualWebBenchTaskAction,
  webshopAction,
} from "../src/index";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

async function invoke(
  action: Action,
  options: HandlerOptions | Record<string, JsonValue | undefined>
) {
  return action.handler(runtime, message, undefined, options);
}

function registeredAction(name: string): Action {
  const action = benchmarksPlugin.actions?.find((candidate) => candidate.name === name);
  if (!action) {
    throw new Error(`${name} must be registered`);
  }
  return action;
}

describe("benchmark umbrella handlers", () => {
  it.each([
    {
      action: vendingMachineAction,
      options: {
        parameters: {
          action: "place_order",
          supplier_id: "supplier-7",
          product_id: "sku-42",
          quantity: 24,
        },
      },
      text: "Bench-side handler — vending-bench environment executes the action.",
      data: {
        action: "place_order",
        supplier_id: "supplier-7",
        product_id: "sku-42",
        quantity: 24,
      },
    },
    {
      action: webshopAction,
      options: {
        action: "search",
        query: "long sleeve cotton dress",
      },
      text: "Bench-side handler — WebShop environment executes the action.",
      data: {
        action: "search",
        query: "long sleeve cotton dress",
      },
    },
    {
      action: osworldAction,
      options: {
        parameters: {
          action: "drag",
          x: 412,
          y: 88,
          direction: "right",
          amount: 120,
        },
      },
      text: "Bench-side handler — OSWorld environment executes the action.",
      data: {
        action: "drag",
        x: 412,
        y: 88,
        direction: "right",
        amount: 120,
      },
    },
    {
      action: tauBenchToolAction,
      options: {
        parameters: {
          tool_name: "search_flights",
          arguments: { origin: "JFK", destination: "LAX", passengers: 2 },
        },
      },
      text: "Bench-side handler — tau-bench environment dispatches the tool call.",
      data: {
        tool_name: "search_flights",
        arguments: { origin: "JFK", destination: "LAX", passengers: 2 },
      },
    },
    {
      action: visualWebBenchTaskAction,
      options: {
        action: "element_ground",
        bbox: [320, 480, 410, 510],
      },
      text: "Bench-side handler — VisualWebBench evaluator scores the action.",
      data: {
        action: "element_ground",
        bbox: [320, 480, 410, 510],
      },
    },
  ])("echoes structured parameters for $action.name", async ({ action, options, text, data }) => {
    await expect(invoke(action, options)).resolves.toEqual({ success: true, text, data });
  });

  it("prefers canonical nested parameters over conflicting compatibility fields", async () => {
    const result = await invoke(vendingMachineAction, {
      action: "collect_cash",
      quantity: 1,
      parameters: {
        action: "restock_slot",
        slot_id: "B4",
        quantity: 8,
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: { action: "restock_slot", slot_id: "B4", quantity: 8 },
    });
  });
});

describe("promoted benchmark actions", () => {
  it.each([
    ["VENDING_MACHINE_SET_PRICE", { slot_id: "A2", price: 2.75 }, "set_price"],
    ["WEBSHOP_SELECT_OPTION", { option_name: "size", option_value: "medium" }, "select_option"],
    ["OSWORLD_SCROLL", { direction: "down", amount: 600 }, "scroll"],
    ["VISUALWEBBENCH_TASK_WEBQA", { answer_text: "Account settings" }, "webqa"],
  ])("pins %s while preserving sibling parameters", async (name, parameters, expectedAction) => {
    const action = registeredAction(name);
    const result = await invoke(action, {
      parameters: { action: "conflicting_value", ...parameters },
    });

    expect(result).toMatchObject({
      success: true,
      data: { action: expectedAction, ...parameters },
    });
  });

  it("keeps optional fields absent instead of fabricating placeholder values", async () => {
    const result = await invoke(registeredAction("OSWORLD_SCREENSHOT"), {
      parameters: {},
    });

    expect(result).toMatchObject({ success: true, data: { action: "screenshot" } });
    expect(result.data).toEqual({ action: "screenshot" });
  });

  it("validates every registered umbrella and virtual action", async () => {
    for (const action of benchmarksPlugin.actions ?? []) {
      await expect(action.validate?.(runtime, message)).resolves.toBe(true);
    }
  });
});
