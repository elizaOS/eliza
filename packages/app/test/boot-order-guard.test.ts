/**
 * Boot-order guard for main()'s pre-mount critical path (perf: client boot
 * parallelization). Pins three structural properties of src/main.tsx source:
 *
 *  1. the @elizaos/ui/voice chunk load is KICKED OFF (startVoiceModuleLoad)
 *     before the storage-bridge await so the chunk download overlaps native
 *     Preferences hydration instead of serializing after it;
 *  2. no bare `await import("@elizaos/ui/voice")` sneaks back onto the boot
 *     path (that reintroduces both the serialization and the
 *     chunk-failure-bricks-boot behavior the loader exists to remove);
 *  3. the two hard orderings survive: storage hydration and the desktop
 *     fused-wake registration stay BEFORE mountReactApp (persisted state is
 *     read at first render; useWakeController probes __ELIZA_FUSED_WAKE__
 *     once at mount).
 *
 * Source-level on purpose: main() is the app entry and cannot be imported in
 * isolation; the loader's runtime behavior is covered by
 * boot-voice-load.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainSrc = readFileSync(
  join(import.meta.dirname, "..", "src", "main.tsx"),
  "utf8",
);

/** The main boot path: from the bridges checkpoint to the platform init. */
function mainBridgesRegion(): string {
  const start = mainSrc.indexOf('markStartup("bridges:start"');
  expect(start).toBeGreaterThan(-1);
  const end = mainSrc.indexOf("await initializePlatform()", start);
  expect(end).toBeGreaterThan(start);
  return mainSrc.slice(start, end);
}

describe("main() boot order", () => {
  it("kicks the voice chunk load off before the bridges/storage await region", () => {
    const kickoff = mainSrc.indexOf(
      "const voiceModuleReady = startVoiceModuleLoad()",
    );
    const bridgesStart = mainSrc.indexOf('markStartup("bridges:start"');
    expect(kickoff).toBeGreaterThan(-1);
    expect(bridgesStart).toBeGreaterThan(-1);
    expect(kickoff).toBeLessThan(bridgesStart);
  });

  it("never re-serializes a bare @elizaos/ui/voice import onto the boot path", () => {
    // The only dynamic voice import lives in boot-voice-load.ts (single-flight
    // + failure-tolerant); main.tsx must consume the shared promise.
    expect(mainSrc).not.toMatch(
      /import\(\s*["'`]@elizaos\/ui\/voice["'`]\s*\)/,
    );
    expect(mainSrc).toContain("await voiceModuleReady");
  });

  it("keeps storage hydration and desktop fused-wake registration before mountReactApp", () => {
    const region = mainBridgesRegion();
    const storageAwait = region.indexOf("await initializeStorageBridge()");
    const fusedWake = region.indexOf("registerDesktopFusedWake()");
    const mount = region.indexOf("mountReactApp()");
    expect(storageAwait).toBeGreaterThan(-1);
    expect(fusedWake).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(-1);
    expect(storageAwait).toBeLessThan(mount);
    expect(fusedWake).toBeLessThan(mount);
  });
});
