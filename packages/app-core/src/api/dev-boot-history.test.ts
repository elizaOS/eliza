/**
 * Unit test for buildBootHistoryPayload — the /api/dev/boot-history payload
 * builder. Verifies plugin-load failures surface via the mocked
 * getLastFailedPluginDetails() accessor from @elizaos/agent (and that an empty
 * accessor yields no failures), exercised against a real temp state dir.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("reads complete persisted telemetry from the supplied state directory", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "eliza-boot-history-"));
    try {
      const record = {
        phases: [{ name: "plugins", durationMs: 17 }],
        detail: "x".repeat(10000),
      };
      await mkdir(path.join(stateDir, "telemetry", "boot"), {
        recursive: true,
      });
      await writeFile(
        path.join(stateDir, "telemetry", "boot", "latest.json"),
        JSON.stringify(record),
      );
      const payload = await buildBootHistoryPayload({
        ELIZA_STATE_DIR: stateDir,
      });
      expect(payload.latestBoot).toEqual(record);
      expect(payload.memory).toBeNull();
      expect(payload.restarts).toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["malformed", "directory"])(
    "rejects %s telemetry instead of reporting absent history",
    async (kind) => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "eliza-boot-history-"),
      );
      const filePath = path.join(stateDir, "telemetry", "boot", "latest.json");
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        if (kind === "directory") await mkdir(filePath);
        else await writeFile(filePath, "{broken");
        await expect(
          buildBootHistoryPayload({ ELIZA_STATE_DIR: stateDir }),
        ).rejects.toMatchObject({
          code:
            kind === "directory"
              ? "BOOT_HISTORY_READ_FAILED"
              : "BOOT_HISTORY_INVALID_JSON",
          context: { filePath },
          cause: expect.any(Error),
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    },
  );

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

  it("reports the real dev watch state from active watcher signals", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "eliza-boot-history-"));
    try {
      await expect(
        buildBootHistoryPayload({
          ELIZA_STATE_DIR: stateDir,
          ELIZA_DEV_NO_WATCH: "0",
        } as NodeJS.ProcessEnv),
      ).resolves.toMatchObject({ watch: false });

      await expect(
        buildBootHistoryPayload({
          ELIZA_STATE_DIR: stateDir,
          ELIZA_DESKTOP_API_WATCH: "1",
        } as NodeJS.ProcessEnv),
      ).resolves.toMatchObject({ watch: true });

      await expect(
        buildBootHistoryPayload({
          ELIZA_STATE_DIR: stateDir,
          ELIZA_DEV_SOURCE_WATCH: "1",
        } as NodeJS.ProcessEnv),
      ).resolves.toMatchObject({ watch: true });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
