/** The deferred static phase never evaluates a plugin the config denies. */
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => [] as string[]);
vi.mock("../src/runtime/optional-plugin-loader.ts", () => ({
  loadOptionalPlugin: async (packageName: string) => {
    loaded.push(packageName);
    return null;
  },
}));

it("skips denied deferred plugins and loads the rest", async () => {
  const { OPTIONAL_STATIC_PLUGIN_REGISTRATIONS } = await import(
    "../src/runtime/optional-plugins.ts"
  );
  const { collectConfiguredDeniedPluginNames } = await import(
    "../src/runtime/plugin-collector.ts"
  );
  const { ensureDeferredCoreStaticPluginsRegistered } = await import(
    "../src/runtime/eliza.ts"
  );
  const { STATIC_ELIZA_PLUGIN_LOADERS } = await import(
    "../src/runtime/plugin-types.ts"
  );
  const [denied, allowed] = OPTIONAL_STATIC_PLUGIN_REGISTRATIONS;
  expect(denied).toBeDefined();
  expect(allowed).toBeDefined();

  await ensureDeferredCoreStaticPluginsRegistered(
    undefined,
    collectConfiguredDeniedPluginNames(
      { plugins: { deny: [denied] } },
      { ELIZA_SKIP_PLUGINS: "" },
    ),
  );

  expect(loaded).not.toContain(denied);
  expect(loaded).toContain(allowed);
  // The lazy loader remains, so a later allow can still resolve it.
  expect(typeof STATIC_ELIZA_PLUGIN_LOADERS[denied]).toBe("function");
});

it("reads ELIZA_SKIP_PLUGINS and short ids", async () => {
  const { collectConfiguredDeniedPluginNames } = await import(
    "../src/runtime/plugin-collector.ts"
  );
  const denied = collectConfiguredDeniedPluginNames(
    { plugins: { deny: ["discord"] } },
    { ELIZA_SKIP_PLUGINS: " @elizaos/plugin-inbox , " },
  );
  expect(denied.has("@elizaos/plugin-discord")).toBe(true);
  expect(denied.has("@elizaos/plugin-inbox")).toBe(true);
  expect(denied.has("")).toBe(false);
});
