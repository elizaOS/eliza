/**
 * Behavioral contract for the Omarchy desktop provider (plugin-omarchy).
 *
 * The provider only runs on Omarchy Linux hosts. Two safety properties:
 *
 * 1. The host gate: on a non-Omarchy host the provider returns an empty
 *    payload and MUST NOT touch the native bridge (no probe, no crash, no
 *    side effects on every other deployment).
 * 2. The degrade contract: when the bridge reports unavailable, the provider
 *    says so explicitly instead of fabricating a snapshot.
 */
import { describe, expect, it, vi } from "vitest";
import { createOmarchyDesktopProvider } from "./desktop";

function bridge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    snapshot: async () => ({
      available: true,
      version: "1.2.3",
      theme: "dark",
      plugins: [],
      ...overrides,
    }),
  } as any;
}

function hostOn(): () => boolean {
  return () => true;
}

function hostOff(): () => boolean {
  return () => false;
}

describe("createOmarchyDesktopProvider — host gate and degrade contract", () => {
  it("pins the provider surface: dynamic, turn-scoped, system/automation/settings contexts", () => {
    const provider = createOmarchyDesktopProvider(bridge(), hostOn());
    expect(provider.name).toBe("omarchyDesktop");
    expect(provider.dynamic).toBe(true);
    expect(provider.contexts).toEqual(["system", "automation", "settings"]);
    expect(provider.contextGate).toEqual({
      anyOf: ["system", "automation", "settings"],
    });
    expect(provider.cacheScope).toBe("turn");
  });

  it("returns empty text on a non-Omarchy host and never touches the bridge", async () => {
    const snap = bridge();
    const spy = vi.spyOn(snap, "snapshot");
    const provider = createOmarchyDesktopProvider(snap, hostOff());

    const out = await provider.get!();

    expect(out).toEqual({ text: "" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports unavailable explicitly when the bridge snapshot is unavailable", async () => {
    const provider = createOmarchyDesktopProvider(
      { snapshot: async () => ({ available: false }) } as any,
      hostOn(),
    );

    const out = await provider.get!();

    expect(out.text).toBe("Omarchy desktop integration is unavailable.");
    expect(out.values).toEqual({ omarchyAvailable: false });
    expect(out.data).toEqual({ available: false });
  });

  it("renders version, theme, and enabled Eliza shell plugin state", async () => {
    const provider = createOmarchyDesktopProvider(
      bridge({
        plugins: [{ id: "elizaos.eliza", enabled: true }],
      }),
      hostOn(),
    );

    const out = await provider.get!();

    expect(out.text).toBe(
      "Omarchy 1.2.3; theme dark; Eliza shell plugin enabled.",
    );
    expect(out.values).toMatchObject({
      omarchyAvailable: true,
      omarchyVersion: "1.2.3",
      omarchyTheme: "dark",
      omarchyElizaPluginInstalled: true,
      omarchyElizaPluginEnabled: true,
    });
  });

  it("reports the Eliza shell plugin as disabled when present but disabled", async () => {
    const provider = createOmarchyDesktopProvider(
      bridge({ plugins: [{ id: "elizaos.eliza", enabled: false }] }),
      hostOn(),
    );

    const out = await provider.get!();

    expect(out.text).toContain("Eliza shell plugin disabled");
    expect(out.values).toMatchObject({ omarchyElizaPluginEnabled: false });
  });

  it("reports the Eliza shell plugin as not installed when absent", async () => {
    const provider = createOmarchyDesktopProvider(
      bridge({ plugins: [] }),
      hostOn(),
    );

    const out = await provider.get!();

    expect(out.text).toContain("Eliza shell plugin not installed");
    expect(out.values).toMatchObject({ omarchyElizaPluginInstalled: false });
  });

  it("omits the theme segment when the snapshot has no theme", async () => {
    const provider = createOmarchyDesktopProvider(
      bridge({ theme: undefined }),
      hostOn(),
    );

    const out = await provider.get!();

    expect(out.text).toContain("Omarchy 1.2.3");
    expect(out.text).not.toContain("theme");
  });
});
