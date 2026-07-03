/**
 * Scenario support for the MOCKED meetings lane (no browser, no ASR, no live
 * model dependency beyond the scenario's own routing model).
 *
 * `installMockSeed()` returns a `custom` seed step that:
 *   1. imports the real @elizaos/plugin-meetings once (runs its module-load
 *      `MeetingService.dependencyFactory = <real>` assignment and caches the ESM
 *      module, so the runner's later `requires.plugins` import returns the cached
 *      module and does NOT re-run the real assignment), then
 *   2. overwrites the factory with the MOCK (browser-free adapter + deterministic
 *      pipeline) via `installMockMeetingDependencies()`.
 *
 * Seeds run before `requires.plugins` registers the meetings plugin (and thus
 * before its service `start()`), so the service is constructed with the mock.
 * See packages/scenario-runner runCustomSeeds → resolveRequiredPlugins ordering.
 */

import {
  clearMockMeetingScripts,
  installMockMeetingDependencies,
  type MockMeetingScript,
  setMockMeetingScript,
} from "../../src/test-support.js";

type SeedStep = {
  type: "custom";
  name?: string;
  apply: () => void | Promise<void>;
};

/**
 * The mock-install seed. `scripts` maps canonical native meeting id →
 * behavior; absent ids fall back to the default (auto-end, canned two speakers).
 */
export function installMockSeed(
  scripts: Record<string, MockMeetingScript> = {},
): SeedStep {
  return {
    type: "custom",
    name: "install mock meetings dependencies (browser-free)",
    apply: async () => {
      // 1. Load the real plugin module once (caches it, runs real assignment).
      await import("@elizaos/plugin-meetings");
      // 2. Override with the mock BEFORE the meetings service starts.
      installMockMeetingDependencies();
      // 3. Reset + seed the per-meeting scripts for this scenario.
      clearMockMeetingScripts();
      for (const [nativeMeetingId, script] of Object.entries(scripts)) {
        setMockMeetingScript(nativeMeetingId, script);
      }
    },
  };
}
