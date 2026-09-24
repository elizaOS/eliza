import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  describeHostExecutionCapabilities,
  getHostExecutionCapabilities,
} from "./task-host-capabilities";

const runtime = { getSetting: () => undefined } as unknown as IAgentRuntime;
afterEach(() => vi.unstubAllGlobals());
it("does not claim long-running background capability for a browser", () => {
  vi.stubGlobal("Capacitor", undefined);
  vi.stubGlobal("process", undefined);
  expect([...getHostExecutionCapabilities(runtime)]).toEqual([
    "foreground",
    "notify-only",
  ]);
});
it("uses the same native plugin evidence in diagnostics and execution", () => {
  vi.stubGlobal("Capacitor", {
    isNativePlatform: () => true,
    Plugins: { BackgroundRunner: {}, ElizaTasks: {} },
  });
  const description = describeHostExecutionCapabilities(runtime);
  expect(description.hasBackgroundRunner).toBe(true);
  expect(description.hasElizaTasksPlugin).toBe(true);
  expect(description.profiles).toEqual([
    ...getHostExecutionCapabilities(runtime),
  ]);
  expect(description.profiles).toContain("bg-heavy-fgs");
});
