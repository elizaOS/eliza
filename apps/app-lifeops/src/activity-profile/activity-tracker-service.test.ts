import type { IAgentRuntime } from "@elizaos/core";
import type { ActivityCollectorEvent } from "@elizaos/native-activity-tracker";
import { describe, expect, test, vi } from "vitest";
import { ActivityTrackerService } from "./activity-tracker-service.js";
import { insertActivityEvent } from "./activity-tracker-repo.js";

let capturedOnEvent: ((event: ActivityCollectorEvent) => void) | null = null;
const stopCollector = vi.fn(async () => undefined);

vi.mock("@elizaos/native-activity-tracker", () => ({
  isSupportedPlatform: vi.fn(() => true),
  startActivityCollector: vi.fn((options: {
    onEvent: (event: ActivityCollectorEvent) => void;
  }) => {
    capturedOnEvent = options.onEvent;
    return { pid: 123, stop: stopCollector };
  }),
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
    event: "focus",
    bundleId: `com.example.${appName}`,
    appName,
    windowTitle: `${appName} window`,
  };
}

describe("ActivityTrackerService", () => {
  test("serializes activity writes and waits for them on stop", async () => {
    capturedOnEvent = null;
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
});
