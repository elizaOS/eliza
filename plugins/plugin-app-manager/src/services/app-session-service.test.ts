import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { APP_SESSION_SERVICE_TYPE } from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { writeAppRunStore } from "./app-run-store.ts";
import { AppSessionService } from "./app-session-service.ts";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-session-service-"));
  tempDirs.push(dir);
  return dir;
}

function minimalRun(appName: string, status: string) {
  return {
    runId: `run-${appName}`,
    appName,
    displayName: appName,
    pluginName: appName,
    launchType: "hosted",
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    viewerAttachment: "unavailable",
    health: { state: "healthy", message: null },
  };
}

afterEach(async () => {
  delete process.env.ELIZA_STATE_DIR;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("AppSessionService", () => {
  it("exposes the canonical service type", () => {
    expect(AppSessionService.serviceType).toBe(APP_SESSION_SERVICE_TYPE);
  });

  it("getRuns reads the AppManager run store at the resolved state dir", async () => {
    const dir = await makeStateDir();
    process.env.ELIZA_STATE_DIR = dir;
    writeAppRunStore(
      // biome-ignore lint/suspicious/noExplicitAny: fixture is normalized on read.
      [minimalRun("@elizaos/plugin-wifi", "running") as any],
      dir,
    );

    const service = await AppSessionService.start({} as IAgentRuntime);
    const runs = service.getRuns();

    expect(runs.map((run) => run.appName)).toContain("@elizaos/plugin-wifi");
    expect(
      runs.find((run) => run.appName === "@elizaos/plugin-wifi")?.status,
    ).toBe("running");
    await service.stop();
  });

  it("getRuns returns an empty list when no store exists", async () => {
    const dir = await makeStateDir();
    process.env.ELIZA_STATE_DIR = dir;
    const service = await AppSessionService.start({} as IAgentRuntime);
    expect(service.getRuns()).toEqual([]);
    await service.stop();
  });
});
