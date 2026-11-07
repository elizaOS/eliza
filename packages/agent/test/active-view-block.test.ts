/**
 * The Active View block names the view-interact capabilities only when the
 * view exposes a scoped action that can reach them. Live tj-783cb093c72b2b:
 * every planner call on the Home chat view said it could "drive everything"
 * through agent-click/agent-fill while no such tool was exposed and the UI
 * context in the same prompt said element IDs are not standalone tools.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
} from "../src/api/views-registry.ts";
import { renderActiveViewContextBlock } from "../src/runtime/view-action-affinity.ts";

const runtimes: IAgentRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});

function runtimeWithBuiltinViews(): IAgentRuntime {
  const runtime = {
    agentId: "22222222-2222-4222-8222-222222222222",
    actions: [],
    getSetting: () => undefined,
    logger: { warn: vi.fn(), debug: vi.fn() },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  runtimes.push(runtime);
  registerBuiltinViews(runtime);
  return runtime;
}

it("describes a view without scoped actions in one line", () => {
  const block = renderActiveViewContextBlock(runtimeWithBuiltinViews(), {
    viewId: "chat",
    viewLabel: "Home",
    viewType: "gui",
    viewPath: "/chat",
  });
  expect(block).toBe(
    '# Active View\nThe user is looking at the "Home" view (id: chat, gui, path /chat).',
  );
});

it("keeps the view-interact lines for a view with scoped actions", () => {
  const block = renderActiveViewContextBlock(runtimeWithBuiltinViews(), {
    viewId: "character",
    viewLabel: "Character",
    viewType: "gui",
    viewPath: "/character",
  });
  expect(block).toContain(
    "You can inspect and drive everything in it through the view-interact capabilities:",
  );
  expect(block).toContain("- VIEW_CHARACTER_FILL_BIO: ");
});
