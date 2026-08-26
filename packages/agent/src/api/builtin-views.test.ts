/**
 * Unit coverage for the first-party `BUILTIN_VIEWS` catalog.
 *
 * The module is a static declaration list (no mutators, no capacity, no
 * comparator). Tests drive the real export and pin the contracts the view
 * registry, agent-surface grant, and launcher rely on.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_VIEWS } from "./builtin-views.ts";

const SOURCE_ORDER_IDS = [
  "camera",
  "device-control",
  "chat",
  "browser",
  "wallet.inventory",
  "character",
  "documents",
  "automations",
  "cloud-apps",
  "plugins-page",
  "trajectories",
  "transcripts",
  "memories",
  "database",
  "logs",
  "vault",
  "settings",
  "background",
] as const;

function requireView(id: string) {
  const found = BUILTIN_VIEWS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`missing builtin view ${id}`);
  }
  return found;
}

describe("BUILTIN_VIEWS", () => {
  it("exports a non-empty catalog (empty-queue case does not apply)", () => {
    expect(Array.isArray(BUILTIN_VIEWS)).toBe(true);
    expect(BUILTIN_VIEWS.length).toBeGreaterThan(0);
    expect(BUILTIN_VIEWS.map((view) => view.id)).toEqual([...SOURCE_ORDER_IDS]);
  });

  it("keeps ids unique", () => {
    const ids = BUILTIN_VIEWS.map((view) => view.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps paths unique among views that declare a path", () => {
    const paths = BUILTIN_VIEWS.map((view) => view.path).filter(
      (path): path is string => typeof path === "string",
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("assigns a unique order to every view (no ties)", () => {
    const orders = BUILTIN_VIEWS.map((view) => view.order);
    expect(orders.every((order) => typeof order === "number")).toBe(true);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("sorts lower order first so chat precedes later shell pages", () => {
    const sorted = [...BUILTIN_VIEWS].sort(
      (left, right) => (left.order ?? 100) - (right.order ?? 100),
    );
    expect(sorted.map((view) => view.id)).toEqual([
      "chat",
      "browser",
      "camera",
      "device-control",
      "wallet.inventory",
      "character",
      "documents",
      "automations",
      "cloud-apps",
      "plugins-page",
      "trajectories",
      "transcripts",
      "memories",
      "database",
      "logs",
      "vault",
      "settings",
      "background",
    ]);
    expect(sorted[0]).toMatchObject({ id: "chat", order: 1, path: "/chat" });
  });

  it("returns undefined when looking up a missing id", () => {
    expect(BUILTIN_VIEWS.find((view) => view.id === "does-not-exist")).toBe(
      undefined,
    );
    expect(
      BUILTIN_VIEWS.filter((view) => view.id === "does-not-exist"),
    ).toEqual([]);
  });

  it("returns a single matching element for a known id", () => {
    const matches = BUILTIN_VIEWS.filter((view) => view.id === "settings");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("/settings");
  });

  it("ships as in-shell views with no remote bundle or frame URLs", () => {
    for (const view of BUILTIN_VIEWS) {
      expect(view.bundlePath, view.id).toBeUndefined();
      expect(view.bundleUrl, view.id).toBeUndefined();
      expect(view.framePath, view.id).toBeUndefined();
      expect(view.frameUrl, view.id).toBeUndefined();
    }
  });

  it("requires id, label, viewKind, tags, and visibleInManager on every entry", () => {
    for (const view of BUILTIN_VIEWS) {
      expect(view.id.length, view.id).toBeGreaterThan(0);
      expect(view.label.length, view.id).toBeGreaterThan(0);
      expect(["system", "release", "developer", "preview"], view.id).toContain(
        view.viewKind,
      );
      expect(Array.isArray(view.tags), view.id).toBe(true);
      expect((view.tags ?? []).length, view.id).toBeGreaterThan(0);
      expect(typeof view.visibleInManager, view.id).toBe("boolean");
    }
  });

  it("hides capability-only, deep-link, and native-webview views from the manager", () => {
    const hidden = BUILTIN_VIEWS.filter(
      (view) => view.visibleInManager === false,
    ).map((view) => view.id);
    expect(hidden).toEqual([
      "device-control",
      "browser",
      "cloud-apps",
      "transcripts",
    ]);
  });

  it("marks developer views with both viewKind and developerOnly", () => {
    const developer = BUILTIN_VIEWS.filter(
      (view) => view.viewKind === "developer",
    );
    expect(developer.map((view) => view.id)).toEqual([
      "trajectories",
      "database",
      "logs",
    ]);
    for (const view of developer) {
      expect(view.developerOnly, view.id).toBe(true);
      expect(view.anticipatoryIntent, view.id).toBeUndefined();
    }
  });

  it("restricts native OS surfaces to android camera and device-control", () => {
    const native = BUILTIN_VIEWS.filter((view) => view.nativeOs === true);
    expect(native.map((view) => view.id)).toEqual(["camera", "device-control"]);
    for (const view of native) {
      expect(view.platforms, view.id).toEqual(["android"]);
    }
  });

  it("gates Vault to OWNER and leaves every other view ungated", () => {
    const gated = BUILTIN_VIEWS.filter((view) => view.roleGate != null);
    expect(gated.map((view) => view.id)).toEqual(["vault"]);
    expect(requireView("vault").roleGate).toEqual({ minRole: "OWNER" });
  });

  it("grants agent-surface only on Character", () => {
    const withGrant = BUILTIN_VIEWS.filter((view) =>
      view.surface?.capabilities?.includes("agent-surface"),
    );
    expect(withGrant.map((view) => view.id)).toEqual(["character"]);
  });

  it("declares scopedActions only on Character", () => {
    const withScoped = BUILTIN_VIEWS.filter(
      (view) => (view.scopedActions?.length ?? 0) > 0,
    );
    expect(withScoped.map((view) => view.id)).toEqual(["character"]);
  });

  it("declares server capabilities only on device-control and Wallet", () => {
    const withCapabilities = BUILTIN_VIEWS.filter(
      (view) => (view.capabilities?.length ?? 0) > 0,
    );
    expect(withCapabilities.map((view) => view.id)).toEqual([
      "device-control",
      "wallet.inventory",
    ]);
  });

  it("describes the camera preview surface", () => {
    expect(requireView("camera")).toMatchObject({
      viewKind: "preview",
      label: "Camera",
      path: "/camera",
      order: 3,
      icon: "Camera",
      visibleInManager: true,
      desktopTabEnabled: true,
      platforms: ["android"],
      nativeOs: true,
    });
  });

  it("describes device-control as a pathless Android capability surface", () => {
    const view = requireView("device-control");
    expect(view.path).toBeUndefined();
    expect(view.heroImagePath).toBeUndefined();
    expect(view).toMatchObject({
      viewKind: "system",
      label: "Device controls",
      order: 4,
      visibleInManager: false,
      desktopTabEnabled: false,
      platforms: ["android"],
      nativeOs: true,
      capabilities: [
        {
          id: "set-flashlight",
          params: {
            enabled: {
              type: "boolean",
              required: true,
            },
          },
        },
      ],
    });
  });

  it("describes chat as the first manager-visible shell page", () => {
    expect(requireView("chat")).toMatchObject({
      viewKind: "system",
      label: "Messages",
      path: "/chat",
      order: 1,
      visibleInManager: true,
      desktopTabEnabled: true,
      platforms: ["web", "desktop", "ios", "android"],
    });
    expect(requireView("chat").anticipatoryIntent).toEqual(expect.any(String));
  });

  it("keeps Browser routable with native-webview isolation and no manager tile", () => {
    expect(requireView("browser")).toMatchObject({
      viewKind: "system",
      path: "/browser",
      order: 2,
      relatedActions: ["BROWSER"],
      visibleInManager: false,
      desktopTabEnabled: true,
      platforms: ["web", "desktop", "ios", "android"],
      surface: { isolation: "native-webview", background: "opaque" },
    });
  });

  it("registers the built-in Wallet route with truthful read/setup capabilities", () => {
    expect(requireView("wallet.inventory")).toMatchObject({
      viewKind: "system",
      label: "Wallet",
      path: "/wallet",
      order: 30,
      capabilities: [{ id: "inspect-wallet" }, { id: "configure-wallet-rpc" }],
      visibleInManager: true,
      desktopTabEnabled: true,
      platforms: ["web", "desktop", "ios", "android"],
    });
    expect(requireView("wallet.inventory").relatedActions).toBeUndefined();
  });

  it("declares Character scoped actions against always-mounted element ids", () => {
    const view = requireView("character");
    expect(view).toMatchObject({
      viewKind: "system",
      path: "/character",
      order: 50,
      relatedActions: ["CHARACTER", "PERSONALITY"],
      surface: { capabilities: ["agent-surface"] },
      visibleInManager: true,
      desktopTabEnabled: true,
    });
    expect(view.scopedActions?.map((action) => action.name)).toEqual([
      "VIEW_CHARACTER_FILL_BIO",
      "VIEW_CHARACTER_ADD_STYLE_RULE",
      "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
    ]);
    expect(view.scopedActions).toEqual([
      {
        name: "VIEW_CHARACTER_FILL_BIO",
        description: expect.stringContaining("bio"),
        similes: expect.arrayContaining(["set bio", "edit bio"]),
        parameters: ["bio"],
        steps: [
          { kind: "agent-fill", target: "identity-bio", value: "{{bio}}" },
        ],
      },
      {
        name: "VIEW_CHARACTER_ADD_STYLE_RULE",
        description: expect.stringContaining("style"),
        similes: expect.arrayContaining(["add style rule"]),
        parameters: ["rule"],
        steps: [
          {
            kind: "agent-fill",
            target: "style-add-input-all",
            value: "{{rule}}",
          },
          { kind: "agent-click", target: "style-add-all" },
        ],
      },
      {
        name: "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
        description: expect.stringContaining("example"),
        similes: expect.arrayContaining(["add message example"]),
        steps: [{ kind: "agent-click", target: "example-add-conversation" }],
      },
    ]);
  });

  it("keeps scoped-action {{param}} tokens aligned with declared parameters", () => {
    for (const view of BUILTIN_VIEWS) {
      for (const action of view.scopedActions ?? []) {
        const tokens = new Set<string>();
        for (const step of action.steps) {
          const matches = step.value?.matchAll(/\{\{([^{}]+)\}\}/g) ?? [];
          for (const match of matches) {
            if (match[1]) tokens.add(match[1]);
          }
        }
        const declared = new Set(action.parameters ?? []);
        expect(
          [...tokens].sort(),
          `${view.id}:${action.name} template tokens`,
        ).toEqual([...declared].sort());
        expect(action.steps.length, action.name).toBeGreaterThan(0);
      }
    }
  });

  it("nests Knowledge under the Character documents path", () => {
    expect(requireView("documents")).toMatchObject({
      id: "documents",
      label: "Knowledge",
      path: "/character/documents",
      order: 51,
      relatedActions: ["OWNER_DOCUMENTS", "DOCUMENT"],
      visibleInManager: true,
      desktopTabEnabled: true,
    });
  });

  it("describes remaining shell pages by path, kind, and affinity", () => {
    expect(requireView("automations")).toMatchObject({
      path: "/automations",
      order: 55,
      relatedActions: ["SCHEDULED_TASKS", "TRIGGER"],
      visibleInManager: true,
    });
    expect(requireView("cloud-apps")).toMatchObject({
      viewKind: "release",
      path: "/cloud-apps",
      order: 58,
      visibleInManager: false,
      platforms: ["web", "desktop", "ios", "android"],
    });
    expect(requireView("plugins-page")).toMatchObject({
      path: "/apps/plugins",
      order: 60,
      relatedActions: ["RUNTIME", "PLUGIN"],
      visibleInManager: true,
    });
    expect(requireView("trajectories")).toMatchObject({
      viewKind: "developer",
      developerOnly: true,
      path: "/apps/trajectories",
      order: 70,
    });
    expect(requireView("transcripts")).toMatchObject({
      label: "Live meeting",
      path: "/apps/transcripts",
      order: 71,
      visibleInManager: false,
    });
    expect(requireView("memories")).toMatchObject({
      developerOnly: false,
      path: "/apps/memories",
      order: 72,
      relatedActions: ["MEMORY"],
      visibleInManager: true,
    });
    expect(requireView("database")).toMatchObject({
      viewKind: "developer",
      developerOnly: true,
      path: "/apps/database",
      order: 80,
    });
    expect(requireView("logs")).toMatchObject({
      viewKind: "developer",
      developerOnly: true,
      path: "/apps/logs",
      order: 81,
    });
    expect(requireView("vault")).toMatchObject({
      path: "/vault",
      order: 89,
      relatedActions: ["SECRETS"],
      desktopTabEnabled: true,
      platforms: ["web", "desktop", "ios", "android"],
    });
    expect(requireView("settings")).toMatchObject({
      path: "/settings",
      order: 90,
      relatedActions: ["RUNTIME", "SETTINGS"],
      visibleInManager: true,
      desktopTabEnabled: true,
    });
    expect(requireView("background")).toMatchObject({
      viewKind: "preview",
      path: "/background",
      order: 92,
      relatedActions: ["BACKGROUND"],
      visibleInManager: true,
      desktopTabEnabled: true,
      platforms: ["web", "desktop", "ios", "android"],
    });
  });

  it("keeps every manager-visible view directly navigable", () => {
    const managerViews = BUILTIN_VIEWS.filter(
      (view) => view.visibleInManager === true,
    );

    expect(managerViews.length).toBeGreaterThan(0);
    for (const view of managerViews) {
      expect(view.path, view.id).toMatch(/^\//);
    }
  });

  it("uses unique non-empty identifiers within capabilities and scoped actions", () => {
    for (const view of BUILTIN_VIEWS) {
      const capabilityIds = (view.capabilities ?? []).map(
        (capability) => capability.id,
      );
      const actionNames = (view.scopedActions ?? []).map(
        (action) => action.name,
      );

      expect(
        capabilityIds.every((id) => id.length > 0),
        view.id,
      ).toBe(true);
      expect(new Set(capabilityIds).size, view.id).toBe(capabilityIds.length);
      expect(
        actionNames.every((name) => name.length > 0),
        view.id,
      ).toBe(true);
      expect(new Set(actionNames).size, view.id).toBe(actionNames.length);
    }
  });
});
