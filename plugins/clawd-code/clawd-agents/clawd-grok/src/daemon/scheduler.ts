import {
  cronMatchesDate,
  getScheduleDaemonStatus,
  getScheduleRunLogPath,
  removeScheduleDaemonPid,
  type ScheduleDaemonStatus,
  ScheduleManager,
  type StoredSchedule,
  startDetachedHeadlessRun,
  writeScheduleDaemonPid,
} from "../tools/schedule";

export class SchedulerDaemon {
  private readonly schedules = new ScheduleManager();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private tickRunning = false;
  private signalHandlersInstalled = false;

  async start(): Promise<void> {
    const status = await getScheduleDaemonStatus();
    if (status.running && status.pid !== process.pid) {
      throw new Error(`Schedule daemon is already running (pid ${status.pid}).`);
    }

    await writeScheduleDaemonPid(process.pid);
    this.installSignalHandlers();

    const allSchedules = await this.schedules.list();
    const recurringCount = allSchedules.filter((schedule) => schedule.enabled && schedule.cron).length;
    console.error(`Schedule daemon started (pid ${process.pid}). Watching ${recurringCount} recurring schedule(s).`);

    await this.tick();
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, 60_000);
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    await removeScheduleDaemonPid();
  }

  async getStatus(): Promise<ScheduleDaemonStatus> {
    return getScheduleDaemonStatus();
  }

  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const shutdown = (signal: NodeJS.Signals) => {
      console.error(`Schedule daemon stopping (${signal}).`);
      void this.stop().finally(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private async tick(): Promise<void> {
    if (this.tickRunning || this.shuttingDown) return;
    this.tickRunning = true;

    try {
      const now = new Date();
      const schedules = await this.schedules.list();

      for (const schedule of schedules) {
        if (!shouldRunScheduleNow(schedule, now)) {
          continue;
        }

        try {
          const pid = await startDetachedHeadlessRun({
            instruction: schedule.instruction,
            directory: schedule.directory,
            model: schedule.model,
            maxToolRounds: schedule.maxToolRounds,
            logPath: getScheduleRunLogPath(schedule.id),
          });

          await this.schedules.touchLastRunAt(schedule.id, now);
          const pidText = pid ? ` (pid ${pid})` : "";
          console.error(`Fired schedule ${schedule.id}${pidText}.`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Schedule ${schedule.id} failed: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Schedule daemon tick failed: ${message}`);
    } finally {
      this.tickRunning = false;
    }
  }
}

function shouldRunScheduleNow(schedule: StoredSchedule, now: Date): boolean {
  if (!schedule.enabled || !schedule.cron) {
    return false;
  }
  if (!cronMatchesDate(schedule.cron, now)) {
    return false;
  }
  if (!schedule.lastRunAt) {
    return true;
  }

  const last = new Date(schedule.lastRunAt);
  if (Number.isNaN(last.getTime())) {
    return true;
  }

  return !isSameMinute(last, now);
}

function isSameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}
