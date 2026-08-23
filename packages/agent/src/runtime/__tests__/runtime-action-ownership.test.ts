import { describe, expect, it, vi } from "vitest";
import {
  applyHostActionOwnership,
  registerFallbackActionIfAbsent,
} from "./runtime-action-ownership.ts";

const APP_CONTROL = "@elizaos/plugin-app-control";
const SETTINGS = { name: "SETTINGS" };
const OTHER = { name: "OTHER" };

describe("applyHostActionOwnership", () => {
  it("returns the plugin untouched for non-app-control plugins", () => {
    const plugin = { name: "@elizaos/plugin-x", actions: [SETTINGS] } as never;
    const runtime = { actions: [{ name: "SETTINGS" }] } as never;
    expect(applyHostActionOwnership(runtime, plugin)).toBe(plugin);
  });

  it("drops the duplicate SETTINGS action when host owns it", () => {
    const plugin = {
      name: APP_CONTROL,
      actions: [SETTINGS, OTHER],
    } as never;
    const runtime = { actions: [{ name: "SETTINGS" }] } as never;
    const out = applyHostActionOwnership(runtime, plugin) as {
      actions: unknown[];
    };
    expect(out.actions).toEqual([OTHER]);
  });

  it("keeps SETTINGS when the host does not own it", () => {
    const plugin = { name: APP_CONTROL, actions: [SETTINGS] } as never;
    const runtime = { actions: [] } as never;
    const out = applyHostActionOwnership(runtime, plugin) as {
      actions: unknown[];
    };
    expect(out.actions).toEqual([SETTINGS]);
  });
});

describe("registerFallbackActionIfAbsent", () => {
  it("registers when absent and returns true", () => {
    const registerAction = vi.fn();
    const runtime = { actions: [], registerAction } as never;
    expect(registerFallbackActionIfAbsent(runtime, SETTINGS as never)).toBe(
      true,
    );
    expect(registerAction).toHaveBeenCalledWith(SETTINGS);
  });

  it("skips when a plugin already owns the name", () => {
    const registerAction = vi.fn();
    const runtime = { actions: [SETTINGS], registerAction } as never;
    expect(registerFallbackActionIfAbsent(runtime, SETTINGS as never)).toBe(
      false,
    );
    expect(registerAction).not.toHaveBeenCalled();
  });
});
