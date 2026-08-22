/**
 * @vitest-environment jsdom
 *
 * Production-loader contract (#16504): loads Personal Assistant's REAL root
 * facade (`./ui.ts`, what the renderer's `@elizaos/plugin-personal-assistant`
 * alias resolves to) and REAL registration entry (`./register.ts`, what the
 * generated side-effect loader imports) together through the app shell's
 * actual dynamic-import cache under the production role-qualified identities.
 * Proves each loader is invoked exactly once across duplicate requests (ES
 * module semantics then guarantee single evaluation), the two identities
 * resolve distinct namespaces with the correct exports, and neither entry can
 * suppress or impersonate the other. No mocks — the real modules load against
 * this package's standing @elizaos/ui test stub.
 */

import { getRendererServiceStates } from "@elizaos/ui/platform/renderer-services";
import { describe, expect, it, vi } from "vitest";
import { cachedDynamicImport } from "../../../packages/app/src/app-module-cache";

// Production identities: main.tsx caches the root facade under the canonical
// package name; the vite transform caches the register entry under the
// role-qualified key (see packages/app/vite/app-side-effect-modules.ts).
const FACADE_KEY = "@elizaos/plugin-personal-assistant";
const REGISTER_KEY = "@elizaos/plugin-personal-assistant#register";

describe("personal-assistant production loader contract", () => {
  it("loads the root facade and register entry together, each exactly once, with the correct exports", async () => {
    const loadFacade = vi.fn(() => import("./ui.js"));
    const loadRegister = vi.fn(() => import("./register.js"));

    // Both identities requested twice — the idle boot schedule and an
    // on-demand consumer racing, as in the production renderer.
    const [facadeA, registerA, facadeB, registerB] = await Promise.all([
      cachedDynamicImport(FACADE_KEY, loadFacade),
      cachedDynamicImport(REGISTER_KEY, loadRegister),
      cachedDynamicImport(FACADE_KEY, loadFacade),
      cachedDynamicImport(REGISTER_KEY, loadRegister),
    ]);

    // Each loader ran exactly once; repeats hit the cached promise.
    expect(loadFacade).toHaveBeenCalledTimes(1);
    expect(loadRegister).toHaveBeenCalledTimes(1);
    expect(facadeA).toBe(facadeB);
    expect(registerA).toBe(registerB);

    // Different module namespaces — the register entry never suppresses the
    // facade (or vice versa) through a shared cache key.
    expect(registerA).not.toBe(facadeA as unknown);

    // The facade carries the browser component surface …
    expect(facadeA.AppBlockerSettingsCard).toBeTypeOf("function");
    expect(facadeA.WebsiteBlockerSettingsCard).toBeTypeOf("function");
    // The removed LifeOps overview has no inert registration shim: renderer
    // behavior is the real lifecycle service plus the two settings cards.
    expect("registerLifeOpsApp" in facadeA).toBe(false);
    // … and no longer the removed React capture effect.
    expect("LifeOpsActivitySignalsEffect" in facadeA).toBe(false);
    // The register entry exports nothing; consumers that expected facade
    // exports would fail loudly if the identities ever collapsed.
    expect("AppBlockerSettingsCard" in registerA).toBe(false);

    // Evaluating the register entry registered the lifecycle-scoped service
    // (main-shell only) in the real renderer-service registry — its work
    // starts only when a main-shell host starts it, never at import.
    const service = getRendererServiceStates().services.find(
      (s) => s.id === "personal-assistant.lifeops-activity-signals",
    );
    expect(service).toBeDefined();
    expect(service?.shells).toEqual(["main"]);
    expect(service?.status).toBe("registered");
  });
});
