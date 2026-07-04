// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  installElizaBridge,
  registerElizaBridgeCapability,
} from "./eliza-window-bridge";

/**
 * Seam test for the single frozen `window.__ELIZA_BRIDGE__` RPC namespace
 * (arch-audit #12091 item 38). Guarantees: the bridge is installed once,
 * frozen, non-writable/non-configurable, its capability accessors delegate to
 * the private registry, and no bare function-valued `__ELIZA_*` slot is written.
 *
 * The bridge and its capability registry are module singletons and the window
 * slot is installed non-configurable, so tests intentionally share one install
 * and run in order. `iosLocalAgentRequest` is never registered here so the
 * "unregistered capability" assertions stay valid for the whole file.
 */
describe("eliza-window-bridge", () => {
  it("installs a single frozen, non-writable, non-configurable bridge object", () => {
    const bridge = installElizaBridge();
    expect(bridge).toBeDefined();
    expect(window.__ELIZA_BRIDGE__).toBe(bridge);
    expect(Object.isFrozen(window.__ELIZA_BRIDGE__)).toBe(true);

    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "__ELIZA_BRIDGE__",
    );
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });

  it("is a no-op on re-installation and returns the same live object", () => {
    const first = installElizaBridge();
    const second = installElizaBridge();
    expect(second).toBe(first);
    expect(window.__ELIZA_BRIDGE__).toBe(first);
  });

  it("cannot be replaced or deleted by a same-origin script", () => {
    const bridge = installElizaBridge();
    expect(() => {
      (window as unknown as { __ELIZA_BRIDGE__: unknown }).__ELIZA_BRIDGE__ =
        () => "evil";
    }).toThrow();
    expect(
      Reflect.deleteProperty(
        window as unknown as Record<string, unknown>,
        "__ELIZA_BRIDGE__",
      ),
    ).toBe(false);
    expect(window.__ELIZA_BRIDGE__).toBe(bridge);
  });

  it("reports an unregistered capability as undefined (matches the pre-bridge window-slot probe)", () => {
    installElizaBridge();
    expect(window.__ELIZA_BRIDGE__?.iosLocalAgentRequest).toBeUndefined();
    expect(typeof window.__ELIZA_BRIDGE__?.iosLocalAgentRequest).toBe(
      "undefined",
    );
  });

  it("exposes a registered capability as a function and delegates to it", async () => {
    const calls: unknown[][] = [];
    registerElizaBridgeCapability("viewInteract", async (...args) => {
      calls.push(args);
      return "ok";
    });
    installElizaBridge();

    const viewInteract = window.__ELIZA_BRIDGE__?.viewInteract;
    expect(typeof viewInteract).toBe("function");
    await expect(
      viewInteract?.("settings", "gui", "list-elements", {}),
    ).resolves.toBe("ok");
    expect(calls).toEqual([["settings", "gui", "list-elements", {}]]);
  });

  it("cannot have a capability accessor overwritten (get-only, no setter)", () => {
    registerElizaBridgeCapability("viewInteract", async () => "real");
    installElizaBridge();
    expect(() => {
      Object.defineProperty(window.__ELIZA_BRIDGE__, "viewInteract", {
        value: () => "evil",
      });
    }).toThrow();
  });
});
