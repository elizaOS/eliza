import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAppRunStore,
  resolveAppRunStoreFilePath,
  resolveLegacyAppRunStoreFilePath,
  writeAppRunStore,
} from "./app-run-store.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-run-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function event(index: number, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `event-${index}`,
    kind: index % 2 === 0 ? "launch" : "unknown-kind",
    severity: index % 3 === 0 ? "warning" : "unknown-severity",
    message: `event ${index}`,
    createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    status: index % 2 === 0 ? "running" : 404,
    details: {
      ok: true,
      dropNull: null,
      nested: {
        kept: "yes",
        dropped: undefined,
      },
    },
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    appName: "sample-app",
    displayName: "Sample App",
    pluginName: "@elizaos/plugin-sample",
    launchType: "hosted",
    launchUrl: 123,
    viewer: {
      url: "https://example.com/app",
      embedParams: { ok: "yes", bad: 1 },
      postMessageAuth: true,
      sandbox: "allow-scripts",
      authMessage: {
        type: "auth",
        authToken: "token",
        ignored: "secret",
      },
    },
    session: {
      sessionId: "session-1",
      appName: "sample-app",
      mode: "bad-mode",
      status: "connected",
      canSendCommands: true,
      controls: ["pause", "delete", "resume"],
      summary: "Session is connected.",
      telemetry: {
        count: 1,
        nested: { ok: true, no: undefined },
        list: ["a", null, 2],
      },
    },
    characterId: 123,
    agentId: 456,
    status: "running",
    summary: undefined,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    lastHeartbeatAt: 123,
    supportsBackground: "yes",
    supportsViewerDetach: false,
    chatAvailability: "invalid",
    controlAvailability: "available",
    viewerAttachment: "invalid",
    recentEvents: Array.from({ length: 25 }, (_, index) => event(index)),
    awaySummary: {
      generatedAt: "2026-01-01T01:00:00.000Z",
      message: "Away summary.",
      eventCount: 25,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-01T01:00:00.000Z",
    },
    health: {
      state: "mystery",
      message: 42,
    },
    healthDetails: {
      checkedAt: 12,
      auth: { state: "healthy", message: "Auth ok" },
      runtime: { state: "bad", message: 99 },
      viewer: null,
      chat: { state: "degraded", message: "Chat flaky" },
      control: { state: "healthy", message: "Control ok" },
      message: "Overall ok",
    },
    ...overrides,
  };
}

function writeStoreFile(
  filePath: string,
  payload: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

describe("app run store", () => {
  it("normalizes persisted v2 runs, events, health, viewer, and session fields", async () => {
    const stateDir = await makeStateDir();
    writeStoreFile(resolveAppRunStoreFilePath(stateDir), {
      version: 2,
      updatedAt: "2026-01-01T02:00:00.000Z",
      runs: [
        run({
          runId: "older",
          updatedAt: "2026-01-01T00:30:00.000Z",
        }),
        run(),
        { runId: "invalid" },
      ],
    });

    const runs = readAppRunStore(stateDir);

    expect(runs.map((entry) => entry.runId)).toEqual(["run-1", "older"]);
    const [first] = runs;
    expect(first).toEqual(
      expect.objectContaining({
        launchUrl: null,
        characterId: null,
        agentId: null,
        summary: "Session is connected.",
        supportsBackground: true,
        supportsViewerDetach: false,
        chatAvailability: "unknown",
        controlAvailability: "available",
        viewerAttachment: "detached",
        health: {
          state: "healthy",
          message: "Session is connected.",
        },
      }),
    );
    expect(first?.viewer).toEqual({
      url: "https://example.com/app",
      postMessageAuth: true,
      sandbox: "allow-scripts",
      authMessage: {
        type: "auth",
        authToken: "token",
      },
    });
    expect(first?.session).toEqual(
      expect.objectContaining({
        mode: "external",
        controls: ["pause", "resume"],
        telemetry: {
          count: 1,
          nested: { ok: true },
          list: ["a", 2],
        },
      }),
    );
    expect(first?.recentEvents).toHaveLength(20);
    expect(first?.recentEvents[0]).toEqual(
      expect.objectContaining({
        eventId: "event-24",
        kind: "launch",
        severity: "warning",
        status: "running",
      }),
    );
    expect(first?.recentEvents.at(-1)?.eventId).toBe("event-5");
    expect(first?.recentEvents.find((item) => item.eventId === "event-23")).toEqual(
      expect.objectContaining({
        kind: "status",
        severity: "info",
        status: null,
        details: {
          ok: true,
          nested: { kept: "yes" },
        },
      }),
    );
    expect(first?.healthDetails).toEqual(
      expect.objectContaining({
        checkedAt: "2026-01-01T01:00:00.000Z",
        auth: { state: "healthy", message: "Auth ok" },
        runtime: { state: "unknown", message: "Session is connected." },
        viewer: { state: "unknown", message: "Viewer detached." },
        chat: { state: "degraded", message: "Chat flaky" },
        control: { state: "healthy", message: "Control ok" },
      }),
    );
  });

  it("migrates legacy v1 stores to the v2 path", async () => {
    const stateDir = await makeStateDir();
    writeStoreFile(resolveLegacyAppRunStoreFilePath(stateDir), {
      version: 1,
      updatedAt: "2026-01-01T02:00:00.000Z",
      runs: [run()],
    });

    const runs = readAppRunStore(stateDir);

    expect(runs).toHaveLength(1);
    expect(fs.existsSync(resolveAppRunStoreFilePath(stateDir))).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(resolveAppRunStoreFilePath(stateDir), "utf8"),
      ).version,
    ).toBe(2);
  });

  it("quarantines corrupt current stores and returns an empty run list", async () => {
    const stateDir = await makeStateDir();
    const currentPath = resolveAppRunStoreFilePath(stateDir);
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(currentPath, "{not json", "utf8");

    expect(readAppRunStore(stateDir)).toEqual([]);
    expect(fs.existsSync(currentPath)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(currentPath))
        .some((name) => name.startsWith("runs.v2.json.corrupt-")),
    ).toBe(true);
  });

  it("writes sorted v2 stores atomically", async () => {
    const stateDir = await makeStateDir();
    const sorted = writeAppRunStore(
      [
        run({ runId: "older", updatedAt: "2026-01-01T00:00:00.000Z" }) as never,
        run({ runId: "newer", updatedAt: "2026-01-01T02:00:00.000Z" }) as never,
      ],
      stateDir,
    );

    expect(sorted.map((entry) => entry.runId)).toEqual(["newer", "older"]);
    const written = JSON.parse(
      fs.readFileSync(resolveAppRunStoreFilePath(stateDir), "utf8"),
    );
    expect(written.version).toBe(2);
    expect(written.runs.map((entry: { runId: string }) => entry.runId)).toEqual([
      "newer",
      "older",
    ]);
  });
});
