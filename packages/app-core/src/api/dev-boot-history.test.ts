/**
 * Unit test for buildBootHistoryPayload — the /api/dev/boot-history payload
 * builder. Verifies plugin-load failures surface via the mocked
 * getLastFailedPluginDetails() accessor from @elizaos/agent (and that an empty
 * accessor yields no failures), exercised against a real temp state dir.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// dev-boot-history reports plugin-load failures by calling the typed
// getLastFailedPluginDetails() accessor from @elizaos/agent — not by re-reading
// a private globalThis symbol. Mock the accessor to prove the wiring
// (Refs #12091 items 30/31).
type FailedPluginDetail = { name: string; error: string };

const { getLastFailedPluginDetails } = vi.hoisted(() => ({
  getLastFailedPluginDetails: vi.fn<() => FailedPluginDetail[]>(() => []),
}));

vi.mock("@elizaos/agent", () => ({
  getLastFailedPluginDetails,
}));

import { buildBootHistoryPayload } from "./dev-boot-history";

describe("buildBootHistoryPayload — failed plugins", () => {
  afterEach(() => {
    getLastFailedPluginDetails.mockReset();
    getLastFailedPluginDetails.mockReturnValue([]);
  });

  it("surfaces failures returned by the agent accessor", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "eliza-boot-history-"));
    try {
      getLastFailedPluginDetails.mockReturnValue([
        { name: "@elizaos/plugin-x", error: "no valid Plugin export" },
      ]);

      const payload = await buildBootHistoryPayload({
        ELIZA_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv);

      expect(getLastFailedPluginDetails).toHaveBeenCalledTimes(1);
      expect(payload.failedPlugins).toEqual([
        { name: "@elizaos/plugin-x", error: "no valid Plugin export" },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports no failures when the accessor returns an empty list", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "eliza-boot-history-"));
    try {
      const payload = await buildBootHistoryPayload({
        ELIZA_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv);
      expect(payload.failedPlugins).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
