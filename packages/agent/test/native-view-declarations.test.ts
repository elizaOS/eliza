import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_VIEWS } from "../src/api/builtin-views.ts";
import { nativeViewDeclarations } from "../src/api/native-view-declarations.ts";
import {
  closeRuntimeViewRegistry,
  getView,
  listViews,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../src/api/views-registry.ts";

const policy = [
  { id: "photos", label: "Photos", path: "/photos" },
  {
    id: "maps",
    label: "Maps",
    path: "/maps",
    fallbackFor: "@elizaos/plugin-maps",
  },
  { id: "camera", label: "Camera", path: "/camera" },
];
const runtimes: IAgentRuntime[] = [];
function runtime() {
  const value = {} as IAgentRuntime;
  runtimes.push(value);
  return value;
}
afterEach(() => {
  for (const value of runtimes.splice(0)) closeRuntimeViewRegistry(value);
  vi.unstubAllEnvs();
});

it("keeps defaults unchanged and host declarations isolated from other runtime installations", () => {
  const ordinary = runtime();
  registerBuiltinViews(ordinary);
  expect(
    listViews(ordinary).some((view) =>
      ["photos", "maps", "camera"].includes(view.id),
    ),
  ).toBe(false);
  vi.stubEnv("ELIZA_NATIVE_VIEW_DECLARATIONS", JSON.stringify(policy));
  const consumer = runtime();
  registerBuiltinViews(consumer);
  for (const { id, path } of policy) {
    expect(getView(consumer, id)).toMatchObject({
      path,
      available: false,
      viewKind: "release",
      roleGate: { minRole: "OWNER" },
      nativeOs: true,
      installationId: expect.any(String),
    });
    expect(getView(consumer, id)?.capabilities).toBeUndefined();
    expect(getView(consumer, id)?.scopedActions).toBeUndefined();
    expect(getView(consumer, id)?.bundleUrl).toBeUndefined();
    expect(listViews(ordinary).some((view) => view.id === id)).toBe(false);
  }
  expect(
    listViews(consumer).some((view) =>
      ["phone", "messages", "contacts"].includes(view.id),
    ),
  ).toBe(false);
  vi.unstubAllEnvs();
  registerBuiltinViews(consumer); // A host cannot rewrite a published installation in place.
  expect(getView(consumer, "maps")?.available).toBe(false);
});

it.each([
  "not-json",
  "{}",
  '[{"id":"maps","label":"Maps","path":"/maps","capabilities":[]}]',
  JSON.stringify([...policy, policy[0]]),
  JSON.stringify([{ id: "settings", label: "Settings", path: "/settings" }]),
  JSON.stringify([{ id: "camera", label: "Camera", path: "/changed" }]),
  JSON.stringify([{ id: "maps", label: " Maps ", path: "/maps" }]),
  JSON.stringify([{ id: "maps", label: "Maps", path: "https://maps.invalid" }]),
  JSON.stringify([{ id: "maps", label: "Maps", path: "/maps/../settings" }]),
  JSON.stringify([{ id: "maps", label: "Maps", path: "/maps?record=private" }]),
])(
  "rejects malformed or capability-bearing launch configuration: %s",
  (raw) => {
    expect(() => nativeViewDeclarations(raw, BUILTIN_VIEWS)).toThrow(
      "Invalid trusted native view declarations",
    );
  },
);

it("preserves an already installed plugin and yields only to the declared package at the same route", async () => {
  vi.stubEnv("ELIZA_NATIVE_VIEW_DECLARATIONS", JSON.stringify(policy));
  const plugin = {
    name: "maps",
    packageName: "@elizaos/plugin-maps",
    description: "Owned fixture",
    views: [
      {
        id: "maps",
        label: "Plugin Maps",
        path: "/maps",
        viewKind: "release" as const,
        bundleUrl: "/maps.js",
      },
    ],
  };
  const first = runtime();
  await registerPluginViews(first, plugin, { pluginDir: process.cwd() });
  registerBuiltinViews(first);
  expect(getView(first, "maps")?.label).toBe("Plugin Maps");
  const second = runtime();
  registerBuiltinViews(second);
  const fallback = getView(second, "maps");
  await expect(
    registerPluginViews(
      second,
      { ...plugin, name: "unrelated", packageName: "@unrelated/maps" },
      { pluginDir: process.cwd() },
    ),
  ).rejects.toThrow("already registered");
  expect(getView(second, "maps")).toBe(fallback);
  const installation = await registerPluginViews(second, plugin, {
    pluginDir: process.cwd(),
  });
  expect(getView(second, "maps")?.label).toBe("Plugin Maps");
  unregisterPluginViews(second, installation);
  expect(getView(second, "maps")).toBe(fallback);
});
