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

import { type IAgentRuntime, Service, logger } from "@elizaos/core";
import {
  type ActivityCollectorEvent,
  type ActivityCollectorHandle,
  isSupportedPlatform,
  startActivityCollector,
} from "@elizaos/native-activity-tracker";
import { insertActivityEvent } from "./activity-tracker-repo.js";

export type ActivityTrackerMode =
  | "running"
  | "disabled-config"
  | "disabled-non-darwin"
  | "failed";

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
    if (
      process.env.MILADY_DISABLE_ACTIVITY_TRACKER === "1" ||
      process.env.ELIZA_DISABLE_ACTIVITY_TRACKER === "1"
    ) {
      this.mode = "disabled-config";
      logger.info(
        "[activity-tracker] Collector disabled by configuration; reports will use seeded data only.",
      );
      return;
    }

    if (!isSupportedPlatform()) {
      this.mode = "disabled-non-darwin";
      logger.info(
        { platform: process.platform },
        "[activity-tracker] Non-Darwin platform — collector disabled; reports will be empty.",
      );
      return;
    }

    try {
      this.handle = startActivityCollector({
        onEvent: (event) => {
          this.enqueueEvent(event);
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
        "[activity-tracker] Failed to start macOS collector; reports will be empty until resolved.",
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
    try {
      await insertActivityEvent(runtime, {
        agentId,
        observedAt,
        eventKind: event.event,
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
}
