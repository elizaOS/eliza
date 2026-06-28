/**
 * First-paint critical-path guard (issue #9565).
 *
 * `initializeAppModules()` blocks the first React mount: `main()` awaits it
 * before `mountReactApp()`. Anything added to its blocking `await Promise.all`
 * delays the first visible startup shell on every device boot. This test pins
 * the blocking set to exactly the modules the boot config reads SYNCHRONOUSLY
 * (companion registration + scene-status hook + inference-notice resolver) so a
 * future eager `import("@elizaos/plugin-…")` added to that await fails CI here
 * instead of silently expanding cold start. Everything else must ride the
 * deferred idle path after React has had a paint opportunity
 * (BOOT_CONFIG_DEFERRED_MODULE_LOADERS / SIDE_EFFECT_APP_MODULE_LOADERS).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const mainSrc = readFileSync(join(root, "src", "main.tsx"), "utf8");

/** Importers allowed to block the first paint inside initializeAppModules(). */
const ALLOWED_BLOCKING_IMPORTERS = new Set([
  "importCompanionAppRegistration",
  "importCompanionSceneStatusContext",
  "importCompanionInferenceNotice",
]);

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

/** The single blocking `await Promise.all([...])` inside initializeAppModules. */
function blockingAwaitSource(): string {
  const fn = initializeAppModulesSource();
  const awaitStart = fn.indexOf("await Promise.all([");
  expect(awaitStart).toBeGreaterThan(-1);
  const awaitEnd = fn.indexOf("]);", awaitStart);
  expect(awaitEnd).toBeGreaterThan(awaitStart);
  return fn.slice(awaitStart, awaitEnd);
}

describe("first-paint critical path", () => {
  it("blocks first paint only on the allow-listed companion importers", () => {
    const blocking = blockingAwaitSource();
    const importers = [...blocking.matchAll(/import[A-Z]\w*\(\)/g)].map((m) =>
      m[0].replace("()", ""),
    );

    expect(importers).toEqual([...ALLOWED_BLOCKING_IMPORTERS]);
    const disallowed = importers.filter(
      (name) => !ALLOWED_BLOCKING_IMPORTERS.has(name),
    );
    expect(disallowed).toEqual([]);
  });

  it("rejects direct dynamic plugin imports on the blocking initializer path", () => {
    const blockingPluginImports = [
      ...initializeAppModulesSource().matchAll(
        BLOCKING_PLUGIN_PACKAGE_IMPORT_PATTERN,
      ),
    ].map((match) => match[2]);

    expect(blockingPluginImports).toEqual([]);
  });

  it("keeps the heavy plugin imports on the deferred idle path", () => {
    const blocking = blockingAwaitSource();
    for (const importer of MUST_BE_DEFERRED) {
      // Not in the blocking await…
      expect(blocking).not.toContain(`${importer}()`);
      // …but still referenced so the deferred loader actually loads it.
      expect(mainSrc).toContain(importer);
    }
    // The deferred loader list exists and is scheduled after React has a paint
    // opportunity, not from initializeAppModules() before mount.
    expect(mainSrc).toContain("BOOT_CONFIG_DEFERRED_MODULE_LOADERS");
    const initializer = initializeAppModulesSource();
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
    // path awaits app modules, then mounts. (Special window-shell paths mount
    // earlier by design and are out of scope.)
    const appModulesIdx = mainSrc.indexOf("await initializeAppModules();");
    const mountIdx = mainSrc.indexOf(
      "mountReactApp();\n  scheduleDeferredAppModuleLoadsAfterPaint();\n  await initializePlatform();",
    );
    expect(appModulesIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeGreaterThan(appModulesIdx);
  });

  it("schedules deferred app modules only after the main React mount", () => {
    const mountIdx = mainSrc.indexOf(
      "mountReactApp();\n  scheduleDeferredAppModuleLoadsAfterPaint();\n  await initializePlatform();",
    );
    expect(mountIdx).toBeGreaterThan(-1);
  });
});
