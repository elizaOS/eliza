/**
 * Verifies known host fallback overlaps are deduplicated while unrelated
 * plugin collisions remain visible to core's normal warning policy.
 */
import type { Action, IAgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  applyHostActionOwnership,
  registerFallbackActionIfAbsent,
} from "./runtime-action-ownership.ts";

function action(name: string): Action {
  return {
    name,
    description: name,
    validate: async () => true,
    handler: async () => ({ success: true }),
    examples: [],
  };
}

describe("runtime action ownership", () => {
  it("removes only app-control SETTINGS when the host already owns it", () => {
    const hostSettings = action("SETTINGS");
    const appControl: Plugin = {
      name: "@elizaos/plugin-app-control",
      description: "App-control fixture",
      actions: [action("APP"), action("SETTINGS")],
    };

    const resolved = applyHostActionOwnership(
      { actions: [hostSettings] },
      appControl,
    );

    expect(resolved).not.toBe(appControl);
    expect(resolved.actions?.map((item) => item.name)).toEqual(["APP"]);
    expect(appControl.actions?.map((item) => item.name)).toEqual([
      "APP",
      "SETTINGS",
    ]);
  });

  it("leaves an unrelated SETTINGS collision for core to diagnose", () => {
    const plugin: Plugin = {
      name: "third-party-settings",
      description: "Third-party settings fixture",
      actions: [action("SETTINGS")],
    };

    expect(
      applyHostActionOwnership({ actions: [action("SETTINGS")] }, plugin),
    ).toBe(plugin);
  });

  it("registers fallback web actions only when no plugin owns the name", () => {
    const registerAction = vi.fn();
    const existing = action("WEB_FETCH");
    const runtime = {
      actions: [existing],
      registerAction,
    } as unknown as Pick<IAgentRuntime, "actions" | "registerAction">;

    expect(registerFallbackActionIfAbsent(runtime, action("WEB_FETCH"))).toBe(
      false,
    );
    expect(registerAction).not.toHaveBeenCalled();

    expect(registerFallbackActionIfAbsent(runtime, action("WEB_SEARCH"))).toBe(
      true,
    );
    expect(registerAction).toHaveBeenCalledOnce();
  });
});
