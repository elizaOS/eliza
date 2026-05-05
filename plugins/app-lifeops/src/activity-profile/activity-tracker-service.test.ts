import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  type ActivityCollectorEvent,
  type ActivityCollectorExit,
  startActivityCollector,
} from "@elizaos/native-activity-tracker";
import { describe, expect, test, vi } from "vitest";
import { LifeOpsRepository } from "../lifeops/repository.js";
import { insertActivityEvent } from "./activity-tracker-repo.js";
import { ActivityTrackerService } from "./activity-tracker-service.js";

let capturedOnEvent: ((event: ActivityCollectorEvent) => void) | null = null;
let capturedOnExit: ((exit: ActivityCollectorExit) => void) | null = null;
let capturedOnFatal: ((reason: string) => void) | null = null;
const stopCollector = vi.fn(async () => undefined);

vi.mock("@elizaos/native-activity-tracker", () => ({
  isSupportedPlatform: vi.fn(() => true),
  startActivityCollector: vi.fn(
    (options: {
      onEvent: (event: ActivityCollectorEvent) => void;
      onExit?: (exit: ActivityCollectorExit) => void;
      onFatal?: (reason: string) => void;
    }) => {
      capturedOnEvent = options.onEvent;
      capturedOnExit = options.onExit ?? null;
      capturedOnFatal = options.onFatal ?? null;
      return { pid: 123, stop: stopCollector };
    },
  ),
}));

vi.mock("./activity-tracker-repo.js", () => ({
  insertActivityEvent: vi.fn(async () => undefined),
}));

const runtime = {
  agentId: "00000000-0000-0000-0000-000000000001",
} as unknown as IAgentRuntime;

function activityEvent(ts: number, appName: string): ActivityCollectorEvent {
  return {
    ts,
    event: "activate",
    bundleId: `com.example.${appName}`,
    appName,
    windowTitle: `${appName} window`,
  };
}

describe("ActivityTrackerService", () => {
  test("bootstraps LifeOps schema before starting the collector", async () => {
    capturedOnEvent = null;
    capturedOnExit = null;
    capturedOnFatal = null;
    vi.mocked(startActivityCollector).mockClear();

    let resolveBootstrap: (() => void) | null = null;
    const bootstrapSpy = vi
      .spyOn(LifeOpsRepository, "bootstrapSchema")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveBootstrap = resolve;
          }),
      );

    try {
      const startPromise = ActivityTrackerService.start(runtime);
      await Promise.resolve();

      expect(bootstrapSpy).toHaveBeenCalledWith(runtime);
      expect(startActivityCollector).not.toHaveBeenCalled();

      resolveBootstrap?.();
      const service = await startPromise;

      expect(startActivityCollector).toHaveBeenCalledOnce();
      await service.stop();
    } finally {
      bootstrapSpy.mockRestore();
    }
  });

  test("serializes activity writes and waits for them on stop", async () => {
    capturedOnEvent = null;
    capturedOnExit = null;
    capturedOnFatal = null;
    stopCollector.mockClear();
    const persisted: string[] = [];
    let releaseFirstWrite: (() => void) | null = null;
    vi.mocked(insertActivityEvent)
      .mockImplementationOnce(
        async (_runtime, event) =>
          await new Promise<void>((resolve) => {
            releaseFirstWrite = () => {
              persisted.push(event.appName);
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async (_runtime, event) => {
        persisted.push(event.appName);
      });

    const service = await ActivityTrackerService.start(runtime);
    expect(capturedOnEvent).toBeTypeOf("function");

    capturedOnEvent?.(activityEvent(1_000, "first"));
    capturedOnEvent?.(activityEvent(2_000, "second"));

    const stopPromise = service.stop();
    await Promise.resolve();
    expect(stopCollector).toHaveBeenCalledOnce();
    expect(persisted).toEqual([]);

    releaseFirstWrite?.();
    await stopPromise;

    expect(persisted).toEqual(["first", "second"]);
    expect(insertActivityEvent).toHaveBeenCalledTimes(2);
  });

  test("persists OS login surfaces as inactive boundaries", async () => {
    capturedOnEvent = null;
    capturedOnExit = null;
    capturedOnFatal = null;
    stopCollector.mockClear();
    vi.mocked(insertActivityEvent).mockClear();

    const service = await ActivityTrackerService.start(runtime);
    capturedOnEvent?.({
      ts: 1_000,
      event: "activate",
      bundleId: "com.apple.loginwindow",
      appName: "loginwindow",
      windowTitle: "Login Window",
    });
    await service.stop();

    expect(insertActivityEvent).toHaveBeenCalledOnce();
    expect(insertActivityEvent).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        eventKind: "deactivate",
        bundleId: "com.apple.loginwindow",
        appName: "loginwindow",
      }),
    );
  });

  test("records clean collector exits without logging a fatal error", async () => {
    capturedOnEvent = null;
    capturedOnExit = null;
    capturedOnFatal = null;
    const errorSpy = vi.spyOn(logger, "error");

    const service = await ActivityTrackerService.start(runtime);
    capturedOnExit?.({
      code: 0,
      signal: null,
      clean: true,
      reason: "collector exited (code=0, signal=null)",
    });

    expect(service.getMode()).toBe("stopped");
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      "[activity-tracker] Collector terminated — events will stop flowing.",
    );
  });

  test("records fatal collector exits as failed", async () => {
    capturedOnEvent = null;
    capturedOnExit = null;
    capturedOnFatal = null;

    const service = await ActivityTrackerService.start(runtime);
    capturedOnFatal?.("collector exited (code=1, signal=null)");

    expect(service.getMode()).toBe("failed");
  });
});
