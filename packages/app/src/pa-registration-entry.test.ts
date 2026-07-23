/**
 * Production-loader identity proof for Personal Assistant's two renderer
 * entries (#16504): the root facade (`@elizaos/plugin-personal-assistant`,
 * aliased to src/ui.ts exactly like the production vite build) and the
 * `appRegister` side-effect entry (src/register.ts, imported by absolute path
 * by the generated loader list). Loading both together must evaluate each
 * exactly once with its own namespace and the correct exports — a shared cache
 * identity would hand one consumer the other's module. Also proves the
 * register entry self-starts the LifeOps activity-signal capture in a primary
 * renderer and stands down in an excluded shell. Real modules end-to-end — the
 * only test double is the URL of the jsdom window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Import specifiers stay inline string literals below — vite's import
// analysis only rewrites literal dynamic imports, and a variable specifier
// resolves against the process root after vi.resetModules.
const PA_ROOT = "@elizaos/plugin-personal-assistant";

function setWindowUrl(url: string): void {
  window.history.replaceState(null, "", url);
}

function visibilityListenerCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(
    ([event]: unknown[]) => event === "visibilitychange",
  ).length;
}

afterEach(() => {
  // The capture controller stops itself on a real (non-bfcache) pagehide;
  // fire one so intervals/listeners never leak across tests.
  window.dispatchEvent(new Event("pagehide"));
  setWindowUrl("/");
  vi.restoreAllMocks();
});

describe("personal-assistant renderer entries", () => {
  it("evaluates the root facade and register entry once each, with distinct namespaces, and self-starts capture in the primary renderer", async () => {
    setWindowUrl("/");
    const addDoc = vi.spyOn(document, "addEventListener");

    // The root facade must not start the capture — that was the removed
    // React-mount path. The capture installs a `visibilitychange` listener on
    // start, so listener deltas discriminate "started" from "not started".
    const root = await import(PA_ROOT);
    const afterRoot = visibilityListenerCount(addDoc);

    const register = await import(
      "@elizaos/plugin-personal-assistant/register"
    );
    const afterRegister = visibilityListenerCount(addDoc);
    expect(afterRegister - afterRoot).toBe(1);

    // Each namespace evaluates once: a re-import yields the identical object,
    // and re-importing never re-starts the capture.
    expect(await import(PA_ROOT)).toBe(root);
    expect(await import("@elizaos/plugin-personal-assistant/register")).toBe(
      register,
    );
    expect(visibilityListenerCount(addDoc)).toBe(afterRegister);

    // Correct exports land on the correct namespace.
    expect(root.AppBlockerSettingsCard).toBeTypeOf("function");
    expect(root.WebsiteBlockerSettingsCard).toBeTypeOf("function");
    expect(root.registerLifeOpsApp).toBeTypeOf("function");
    // The register entry is side-effect-only by contract: consuming plugin
    // API through it means the loader handed out the wrong namespace.
    expect(Object.keys(register as Record<string, unknown>)).toEqual([]);
    expect(register).not.toBe(root);

    // The controller is a singleton: with the register entry's capture live,
    // another start returns the active stop instead of installing a second
    // listener set.
    const { startLifeOpsActivitySignalCapture } = await import(
      "@elizaos/plugin-personal-assistant/lifeops/activity-signals-capture"
    );
    const stop = startLifeOpsActivitySignalCapture();
    expect(stop).toBeTypeOf("function");
    expect(visibilityListenerCount(addDoc)).toBe(afterRegister);
    stop();
  });

  it("starts nothing when evaluated in an excluded window shell", async () => {
    vi.resetModules();
    setWindowUrl("/?popout=1");
    const addDoc = vi.spyOn(document, "addEventListener");

    await import("@elizaos/plugin-personal-assistant/register");
    expect(visibilityListenerCount(addDoc)).toBe(0);
  });
});
