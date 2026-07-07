/**
 * First-paint critical-path guard (issue #9565).
 *
 * `initializeAppModules()` blocks the first React mount: `main()` awaits it
 * before `mountReactApp()`. Anything added to its blocking path delays the first
 * visible startup shell on every device boot. The boot config reads no plugin
 * module synchronously, so the initializer must load only `@elizaos/app-core`
 * (the boot-config singleton owner) and never eagerly `import("@elizaos/plugin-…")`.
 * This test fails CI if a future eager plugin import is added to that path
 * instead of riding the deferred idle loaders
 * (BOOT_CONFIG_DEFERRED_MODULE_LOADERS / SIDE_EFFECT_APP_MODULE_LOADERS) after
 * React has had a paint opportunity.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const mainSrc = readFileSync(join(root, "src", "main.tsx"), "utf8");

/** Heavy app plugins that must NOT block first paint — deferred to idle. */
const MUST_BE_DEFERRED = [
  "importPersonalAssistant",
  "importAppTaskCoordinator",
  "importAppTaskCoordinatorRegister",
  "importAppPhone",
  "importAppTraining",
];

const BLOCKING_PLUGIN_PACKAGE_IMPORT_PATTERN =
  /import\(\s*(["'`])(@elizaos\/plugin-[^"'`]+)\1\s*\)/g;

function initializeAppModulesSource(): string {
  const start = mainSrc.indexOf("function initializeAppModules(");
  expect(start).toBeGreaterThan(-1);
  const end = mainSrc.indexOf("return appModulesInitialized;", start);
  expect(end).toBeGreaterThan(start);
  return mainSrc.slice(start, end);
}

describe("first-paint critical path", () => {
  it("rejects direct dynamic plugin imports on the blocking initializer path", () => {
    const blockingPluginImports = [
      ...initializeAppModulesSource().matchAll(
        BLOCKING_PLUGIN_PACKAGE_IMPORT_PATTERN,
      ),
    ].map((match) => match[2]);

    expect(blockingPluginImports).toEqual([]);
  });

  it("keeps the heavy plugin imports on the deferred idle path", () => {
    const initializer = initializeAppModulesSource();
    for (const importer of MUST_BE_DEFERRED) {
      // Not called on the blocking initializer path…
      expect(initializer).not.toContain(`${importer}()`);
      // …but still referenced so the deferred loader actually loads it.
      expect(mainSrc).toContain(importer);
    }
    // The deferred loader list exists and is scheduled after React has a paint
    // opportunity, not from initializeAppModules() before mount.
    expect(mainSrc).toContain("BOOT_CONFIG_DEFERRED_MODULE_LOADERS");
    expect(initializer).not.toMatch(
      /scheduleAppModuleIdleLoads\(\s*BOOT_CONFIG_DEFERRED_MODULE_LOADERS\s*\)/,
    );
    expect(initializer).not.toMatch(
      /scheduleAppModuleIdleLoads\(\s*SIDE_EFFECT_APP_MODULE_LOADERS\s*\)/,
    );
    expect(mainSrc).toMatch(
      /function scheduleDeferredAppModuleLoadsAfterPaint\(\)[\s\S]*scheduleAfterReactPaint\([\s\S]*scheduleAppModuleIdleLoads\(\s*BOOT_CONFIG_DEFERRED_MODULE_LOADERS\s*\)[\s\S]*scheduleAppModuleIdleLoads\(\s*SIDE_EFFECT_APP_MODULE_LOADERS\s*\)/,
    );
  });

  it("still mounts React only after initializeAppModules in the main boot path", () => {
    // Guards the ordering invariant the whole optimization rests on: the normal
    // path awaits app modules, then mounts, then initializes the platform.
    // (Special window-shell paths mount earlier by design and are out of
    // scope.) Post-mount fire-and-forget work may sit between the deferred
    // schedule and the platform await, so only the ordering is pinned.
    const appModulesIdx = mainSrc.indexOf("await initializeAppModules();");
    const mountIdx = mainSrc.indexOf(
      "mountReactApp();\n  scheduleDeferredAppModuleLoadsAfterPaint();",
    );
    const platformIdx = mainSrc.indexOf("await initializePlatform();");
    expect(appModulesIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeGreaterThan(appModulesIdx);
    expect(platformIdx).toBeGreaterThan(mountIdx);
  });

  it("schedules deferred app modules only after the main React mount", () => {
    const mountIdx = mainSrc.indexOf(
      "mountReactApp();\n  scheduleDeferredAppModuleLoadsAfterPaint();",
    );
    expect(mountIdx).toBeGreaterThan(-1);
  });
});
