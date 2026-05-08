/**
 * T8d — Activity tracker service.
 *
 * Starts the macOS Swift collector (when available) and writes focus events
 * to `life_activity_events`. On non-Darwin platforms the service is a no-op
 * that logs "no events" once at startup and returns empty reports via the
 * action layer.
 *
 * The service does not mutate any cached profile state; reporting runs on
 * demand via {@link getActivityReport}.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  createLifeOpsActivitySignal,
  LifeOpsRepository,
} from "../lifeops/repository.js";
import { insertActivityEvent } from "./activity-tracker-repo.js";
import { isSystemInactivityApp } from "./system-inactivity-apps.js";

export type ActivityTrackerMode =
  | "running"
  | "disabled-config"
  | "disabled-non-darwin"
  | "stopped"
  | "failed";

interface ActivityCollectorEvent {
  ts: number;
  bundleId?: string;
  appName?: string;
  windowTitle?: string | null;
  event: "activate" | "deactivate" | string;
}

interface ActivityCollectorIdleSample {
  ts: number;
  idleSeconds: number;
}

interface ActivityCollectorHandle {
  pid?: number;
  stop: () => Promise<void> | void;
}

type ActivityTrackerModule = {
  isSupportedPlatform: () => boolean;
  startActivityCollector: (opts: {
    onEvent: (event: ActivityCollectorEvent) => void;
    onIdleSample: (sample: ActivityCollectorIdleSample) => void;
    onExit: (exit: { reason?: string }) => void;
    onFatal: (reason: string) => void;
  }) => ActivityCollectorHandle;
};

async function loadActivityTrackerModule(): Promise<ActivityTrackerModule | null> {
  try {
    return (await import(
      "@elizaos/native-activity-tracker"
    )) as ActivityTrackerModule;
  } catch {
    return null;
  }
}

export class ActivityTrackerService extends Service {
  static override readonly serviceType = "activity_tracker";

  override capabilityDescription =
    "T8d — macOS activity tracker. Records per-app focus transitions to life_activity_events for WakaTime-style reports.";

  private handle: ActivityCollectorHandle | null = null;
  private mode: ActivityTrackerMode = "disabled-non-darwin";
  private writeFailures = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ActivityTrackerService> {
    const service = new ActivityTrackerService(runtime);
    await service.startCollector();
    return service;
  }

  override async stop(): Promise<void> {
    if (this.handle) {
      await this.handle.stop();
      this.handle = null;
    }
    await this.writeQueue;
  }

  getMode(): ActivityTrackerMode {
    return this.mode;
  }

  private async startCollector(): Promise<void> {
    if (process.env.ELIZA_DISABLE_ACTIVITY_TRACKER === "1") {
      this.mode = "disabled-config";
      logger.info(
        "[activity-tracker] Collector disabled by configuration; reports will use seeded data only.",
      );
      return;
    }

    const tracker = await loadActivityTrackerModule();
    if (!tracker) {
      this.mode = "disabled-config";
      logger.info(
        "[activity-tracker] Native collector package unavailable; reports will use seeded data only.",
      );
      return;
    }

    if (!tracker.isSupportedPlatform()) {
      this.mode = "disabled-non-darwin";
      logger.info(
        { platform: process.platform },
        "[activity-tracker] Non-Darwin platform — collector disabled; reports will be empty.",
      );
      return;
    }

    try {
      await LifeOpsRepository.bootstrapSchema(this.runtime);
      this.handle = tracker.startActivityCollector({
        onEvent: (event) => {
          this.enqueueEvent(event);
        },
        onIdleSample: (sample) => {
          this.enqueueIdleSample(sample);
        },
        onExit: (exit) => {
          this.mode = "stopped";
          logger.info(
            { reason: exit.reason },
            "[activity-tracker] Collector exited cleanly; events will stop flowing.",
          );
        },
        onFatal: (reason) => {
          this.mode = "failed";
          logger.error(
            { reason },
            "[activity-tracker] Collector terminated — events will stop flowing.",
          );
        },
      });
      this.mode = "running";
      logger.info(
        { pid: this.handle.pid },
        "[activity-tracker] macOS collector running.",
      );
    } catch (err) {
      this.mode = "failed";
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: message },
        "[activity-tracker] Failed to initialize macOS collector; reports will be empty until resolved.",
      );
    }
  }

  private enqueueEvent(event: ActivityCollectorEvent): void {
    this.writeQueue = this.writeQueue.then(
      () => this.persistEvent(event),
      () => this.persistEvent(event),
    );
  }

  private async persistEvent(event: ActivityCollectorEvent): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const agentId = String(runtime.agentId);
    const observedAt = new Date(event.ts).toISOString();
    const eventKind = isSystemInactivityApp({
      bundleId: event.bundleId,
      appName: event.appName,
      platform: process.platform,
    })
      ? "deactivate"
      : event.event;
    try {
      await insertActivityEvent(runtime, {
        agentId,
        observedAt,
        eventKind,
        bundleId: event.bundleId,
        appName: event.appName,
        windowTitle: event.windowTitle ?? null,
      });
      this.writeFailures = 0;
    } catch (err) {
      this.writeFailures += 1;
      if (this.writeFailures <= 3) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[activity-tracker] Failed to persist activity event.",
        );
      }
    }
  }

  private enqueueIdleSample(sample: ActivityCollectorIdleSample): void {
    this.writeQueue = this.writeQueue.then(
      () => this.persistIdleSample(sample),
      () => this.persistIdleSample(sample),
    );
  }

  /**
   * Persist a HID idle sample as a `desktop_interaction` activity signal.
   * The scorer reads `idleTimeSeconds` from the latest signal to distinguish
   * passive-media (high idle) from active-use (low idle) per the
   * shared-device-safety rule in `awake-probability.ts`.
   */
  private async persistIdleSample(
    sample: ActivityCollectorIdleSample,
  ): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const agentId = String(runtime.agentId);
    const observedAt = new Date(sample.ts).toISOString();
    const idleSeconds = Math.max(0, Math.round(sample.idleSeconds));
    try {
      const repository = new LifeOpsRepository(runtime);
      await repository.createActivitySignal(
        createLifeOpsActivitySignal({
          agentId,
          source: "desktop_interaction",
          platform: "macos_activity_collector",
          state:
            idleSeconds <= 60
              ? "active"
              : idleSeconds <= 300
                ? "idle"
                : "background",
          observedAt,
          idleState:
            idleSeconds <= 60
              ? "active"
              : idleSeconds <= 300
                ? "idle"
                : "unknown",
          idleTimeSeconds: idleSeconds,
          onBattery: null,
          health: null,
          metadata: {
            source: "activity_collector_hid_idle",
          },
        }),
      );
      this.writeFailures = 0;
    } catch (err) {
      this.writeFailures += 1;
      if (this.writeFailures <= 3) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[activity-tracker] Failed to persist idle sample.",
        );
      }
    }
  }
}
