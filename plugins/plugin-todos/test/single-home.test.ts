/**
 * Todos single-home contract (arch-audit #12092 item 20, todos slice).
 *
 * Todos used to be split-brain: @elizaos/core baked a JSON-file `todosProvider`
 * + `TodosService` into its `advanced-capabilities` bundle (gated by the
 * `advancedCapabilities` flag) while the canonical, DB-backed todos capability
 * lived in this plugin. Core's copy had no writer action anywhere, so its
 * provider always emitted an empty list — dead, duplicate code.
 *
 * These tests pin the reconciliation:
 *  1. Core's advanced-capabilities bundle (and the `advancedCapabilities` flag
 *     path) no longer registers any todos provider or service.
 *  2. @elizaos/plugin-todos fully owns the todos capability — the `TODO` action,
 *     the `CURRENT_TODOS` provider, and the `TodosService` all live here — so the
 *     capability resolves via plugin registration.
 */
import {
  advancedCapabilities,
  advancedProviders,
  advancedServices,
  createBasicCapabilitiesPlugin,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

// Import the capability pieces from their leaf modules rather than the plugin
// barrel (`../src/index.js`) — the barrel also pulls in the React spatial view,
// whose `@elizaos/ui/spatial` dependency is not built in this unit-test lane.
import { todoAction } from "../src/actions/todo.js";
import { currentTodosProvider } from "../src/providers/current-todos.js";
import { TodosService } from "../src/service.js";
import { TODOS_SERVICE_TYPE } from "../src/types.js";

const isTodoName = (name: string): boolean => /todo/i.test(name);

describe("todos single-home: core no longer bakes todos into advanced-capabilities", () => {
  it("advancedProviders contains no todos provider", () => {
    expect(advancedProviders.some((p) => isTodoName(p.name))).toBe(false);
    expect(advancedCapabilities.providers.some((p) => isTodoName(p.name))).toBe(
      false,
    );
  });

  it("advancedServices contains no todos service", () => {
    expect(advancedServices.some((s) => isTodoName(String(s.serviceType)))).toBe(
      false,
    );
  });

  it("the advancedCapabilities flag path registers no todos provider or service", () => {
    const plugin = createBasicCapabilitiesPlugin({ advancedCapabilities: true });
    expect((plugin.providers ?? []).some((p) => isTodoName(p.name))).toBe(false);
    expect(
      (plugin.services ?? []).some((s) => isTodoName(String(s.serviceType))),
    ).toBe(false);
  });
});

describe("todos single-home: plugin-todos owns the whole todos capability", () => {
  it("provides the TODO action, the CURRENT_TODOS provider, and TodosService", () => {
    expect(todoAction.name).toBe("TODO");
    expect(currentTodosProvider.name).toBe("CURRENT_TODOS");
    expect(TodosService.serviceType).toBe(TODOS_SERVICE_TYPE);
  });
});
