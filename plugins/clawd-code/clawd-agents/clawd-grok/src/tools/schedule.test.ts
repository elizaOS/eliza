import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importScheduleModule(options: { home?: string; spawnMock?: ReturnType<typeof vi.fn> } = {}) {
  vi.resetModules();
  vi.doUnmock("os");
  vi.doUnmock("child_process");

  if (options.home) {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return {
        ...actual,
        homedir: () => options.home!,
      };
    });
  }

  if (options.spawnMock) {
    vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process");
      return {
        ...actual,
        spawn: options.spawnMock,
      };
    });
  }

  return import("./schedule");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("os");
  vi.doUnmock("child_process");
});

describe("schedule helpers", () => {
  it("validates cron expressions and matches dates", async () => {
    const mod = await importScheduleModule();

    expect(mod.isValidCron("*/15 9-17 * * 1-5")).toBe(true);
    expect(mod.isValidCron("0 9 * *")).toBe(false);
    expect(mod.isValidCron("61 9 * * *")).toBe(false);
    expect(mod.toScheduleId("Daily Security Scan!")).toBe("daily-security-scan");
    expect(mod.toScheduleId("..")).toBe("");
    expect(mod.toScheduleId(".")).toBe("");
    expect(mod.toScheduleId("../../../etc")).toBe("etc");
    expect(mod.toScheduleId("legit.name")).toBe("legit-name");

    expect(() => mod.getScheduleLogDir("..")).toThrow("path traversal");
    expect(() => mod.getScheduleLogDir("../..")).toThrow("path traversal");

    const matchingDate = new Date("2026-03-25T09:30:00");
    const nonMatchingDate = new Date("2026-03-29T09:30:00");

    expect(mod.cronMatchesDate("30 9 * * 1-5", matchingDate)).toBe(true);
    expect(mod.cronMatchesDate("30 9 * * 1-5", nonMatchingDate)).toBe(false);
    expect(mod.cronMatchesDate("*/10 * * * *", new Date("2026-03-25T09:40:00"))).toBe(true);

    expect(mod.isValidCron("0 9 * * 5-7")).toBe(true);
    const friday = new Date("2026-03-27T09:00:00");
    const sunday = new Date("2026-03-29T09:00:00");
    const monday = new Date("2026-03-30T09:00:00");
    expect(mod.cronMatchesDate("0 9 * * 5-7", friday)).toBe(true);
    expect(mod.cronMatchesDate("0 9 * * 5-7", sunday)).toBe(true);
    expect(mod.cronMatchesDate("0 9 * * 5-7", monday)).toBe(false);
  });

  it("creates, lists, and removes recurring schedules under ~/.grok/schedules", async () => {
    const home = makeTempDir("grok-schedule-home-");
    const cwd = makeTempDir("grok-schedule-cwd-");
    const mod = await importScheduleModule({ home });
    const manager = new mod.ScheduleManager(
      () => cwd,
      () => "grok-test-model",
    );
    const name = `Daily Security Scan ${path.basename(home)}`;
    const id = mod.toScheduleId(name);

    const result = await manager.create({
      name,
      instruction: "Scan the repo for security issues.",
      cron: "0 9 * * 1-5",
    });

    expect(result.startedPid).toBeNull();
    expect(result.schedule).toMatchObject({
      id,
      model: "grok-test-model",
      directory: cwd,
      cron: "0 9 * * 1-5",
      enabled: true,
    });

    const recordPath = mod.getScheduleRecordPath(id);
    expect(fs.existsSync(recordPath)).toBe(true);

    const listed = await manager.list();
    expect(listed.some((schedule) => schedule.id === id)).toBe(true);

    const removed = await manager.remove(id);
    expect(removed?.name).toBe(name);
    const afterRemove = await manager.list();
    expect(afterRemove.some((schedule) => schedule.id === id)).toBe(false);
  });

  it("builds headless CLI args for scheduled runs", async () => {
    const mod = await importScheduleModule();

    expect(
      mod.buildHeadlessCliArgs({
        directory: "/repo",
        instruction: "Summarize the repository status.",
        model: "grok-test-model",
        maxToolRounds: 123,
      }),
    ).toEqual([
      "--directory",
      "/repo",
      "--prompt",
      "Summarize the repository status.",
      "--model",
      "grok-test-model",
      "--max-tool-rounds",
      "123",
    ]);
  });
});
