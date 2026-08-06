import { afterEach, describe, expect, it, vi } from "vitest";

async function importSchedulerModule(mocks: {
  list: ReturnType<typeof vi.fn>;
  touchLastRunAt: ReturnType<typeof vi.fn>;
  startDetachedHeadlessRun?: ReturnType<typeof vi.fn>;
  getScheduleDaemonStatus?: ReturnType<typeof vi.fn>;
  writeScheduleDaemonPid?: ReturnType<typeof vi.fn>;
  removeScheduleDaemonPid?: ReturnType<typeof vi.fn>;
  cronMatchesDate?: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();

  const startDetachedHeadlessRun = mocks.startDetachedHeadlessRun ?? vi.fn(async () => 9876);
  const getScheduleDaemonStatus = mocks.getScheduleDaemonStatus ?? vi.fn(async () => ({ running: false, pid: null }));
  const writeScheduleDaemonPid = mocks.writeScheduleDaemonPid ?? vi.fn(async () => {});
  const removeScheduleDaemonPid = mocks.removeScheduleDaemonPid ?? vi.fn(async () => {});
  const cronMatchesDate = mocks.cronMatchesDate ?? vi.fn(() => true);

  vi.doMock("../tools/schedule", () => ({
    ScheduleManager: class {
      list = mocks.list;
      touchLastRunAt = mocks.touchLastRunAt;
    },
    cronMatchesDate,
    getScheduleDaemonStatus,
    getScheduleRunLogPath: (id: string) => `/tmp/${id}.log`,
    removeScheduleDaemonPid,
    startDetachedHeadlessRun,
    writeScheduleDaemonPid,
  }));

  const mod = await import("./scheduler");
  return {
    SchedulerDaemon: mod.SchedulerDaemon,
    startDetachedHeadlessRun,
    getScheduleDaemonStatus,
    writeScheduleDaemonPid,
    removeScheduleDaemonPid,
    cronMatchesDate,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("SchedulerDaemon", () => {
  it("fires matching recurring schedules and records lastRunAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T09:00:00"));

    const list = vi.fn(async () => [
      {
        id: "daily-security-scan",
        name: "Daily Security Scan",
        instruction: "Scan the repo.",
        cron: "0 9 * * 1-5",
        model: "grok-test-model",
        directory: "/repo",
        enabled: true,
        maxToolRounds: 400,
        createdAt: "2026-03-25T08:00:00.000Z",
        updatedAt: "2026-03-25T08:00:00.000Z",
      },
    ]);
    const touchLastRunAt = vi.fn(async () => {});

    const { SchedulerDaemon, startDetachedHeadlessRun, writeScheduleDaemonPid, removeScheduleDaemonPid } =
      await importSchedulerModule({
        list,
        touchLastRunAt,
      });

    const daemon = new SchedulerDaemon();
    await daemon.start();

    expect(writeScheduleDaemonPid).toHaveBeenCalledWith(process.pid);
    expect(startDetachedHeadlessRun).toHaveBeenCalledWith({
      instruction: "Scan the repo.",
      directory: "/repo",
      model: "grok-test-model",
      maxToolRounds: 400,
      logPath: "/tmp/daily-security-scan.log",
    });
    expect(touchLastRunAt).toHaveBeenCalledWith("daily-security-scan", expect.any(Date));

    await daemon.stop();
    expect(removeScheduleDaemonPid).toHaveBeenCalled();
  });

  it("does not refire a schedule that already ran in the same minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T09:00:30.000Z"));

    const list = vi.fn(async () => [
      {
        id: "daily-security-scan",
        name: "Daily Security Scan",
        instruction: "Scan the repo.",
        cron: "* * * * *",
        model: "grok-test-model",
        directory: "/repo",
        enabled: true,
        maxToolRounds: 400,
        lastRunAt: "2026-03-25T09:00:00.000Z",
        createdAt: "2026-03-25T08:00:00.000Z",
        updatedAt: "2026-03-25T09:00:00.000Z",
      },
    ]);
    const touchLastRunAt = vi.fn(async () => {});

    const { SchedulerDaemon, startDetachedHeadlessRun } = await importSchedulerModule({
      list,
      touchLastRunAt,
    });

    const daemon = new SchedulerDaemon();
    await daemon.start();

    expect(startDetachedHeadlessRun).not.toHaveBeenCalled();
    expect(touchLastRunAt).not.toHaveBeenCalled();

    await daemon.stop();
  });
});
