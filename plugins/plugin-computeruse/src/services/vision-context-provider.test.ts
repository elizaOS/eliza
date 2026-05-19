/**
 * Unit tests for VisionContextProvider.
 *
 * Verifies the provider:
 *   - aggregates open apps (deduped, capped at 50) from listProcesses
 *   - prefers the bbox-bearing focused window from ComputerUseService.getCurrentScene
 *   - falls back to listWindows() when no scene is registered
 *   - exposes the recent-actions ring buffer with capacity 10
 *   - reads the task goal from runtime.getCache and treats whitespace-only
 *     values as null
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene, SceneFocusedWindow } from "../scene/scene-types.js";
import { ComputerUseService } from "./computer-use-service.js";
import {
  VisionContextProvider,
  VISION_CONTEXT_SERVICE_TYPE,
  VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
} from "./vision-context-provider.js";

vi.mock("../platform/process-list.js", () => ({
  listProcesses: vi.fn(() => [] as Array<{ pid: number; name: string }>),
}));

vi.mock("../platform/windows-list.js", () => ({
  listWindows: vi.fn(() => [] as Array<{ id: string; title: string; app: string }>),
}));

import { listProcesses } from "../platform/process-list.js";
import { listWindows } from "../platform/windows-list.js";

interface RuntimeStub {
  cache: Map<string, unknown>;
  computerUse: ComputerUseService | null;
  runtime: IAgentRuntime;
}

function makeRuntime(opts: {
  taskGoal?: unknown;
  scene?: Scene | null;
} = {}): RuntimeStub {
  const cache = new Map<string, unknown>();
  if (opts.taskGoal !== undefined) {
    cache.set(VISION_CONTEXT_TASK_GOAL_CACHE_KEY, opts.taskGoal);
  }

  const computerUse =
    opts.scene === undefined
      ? null
      : ({
          getCurrentScene: () => opts.scene ?? null,
        } as unknown as ComputerUseService);

  const runtime = {
    agentId: "agent-vision-ctx",
    character: {},
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    getService: vi.fn((name: string) => {
      if (name === ComputerUseService.serviceType) return computerUse;
      return null;
    }),
  } as unknown as IAgentRuntime;

  return { cache, computerUse, runtime };
}

function makeFocusedWindow(): SceneFocusedWindow {
  return {
    app: "Cursor",
    pid: 12345,
    bounds: [0, 0, 1440, 900],
    title: "vision-context-provider.ts — eliza",
    displayId: 0,
  };
}

function makeScene(): Scene {
  return {
    timestamp: Date.now(),
    displays: [],
    focused_window: makeFocusedWindow(),
    apps: [],
    ocr: [],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

beforeEach(() => {
  vi.mocked(listProcesses).mockReturnValue([]);
  vi.mocked(listWindows).mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("VisionContextProvider — service registration", () => {
  it("declares the canonical service type and is consumer-discoverable", () => {
    expect(VisionContextProvider.serviceType).toBe(VISION_CONTEXT_SERVICE_TYPE);
    expect(VISION_CONTEXT_SERVICE_TYPE).toBe("vision-context");
  });

  it("starts cleanly via Service.start without touching disk", async () => {
    const { runtime } = makeRuntime();
    const instance = await VisionContextProvider.start(runtime);
    expect(instance).toBeInstanceOf(VisionContextProvider);
  });
});

describe("VisionContextProvider — open apps", () => {
  it("returns process names deduped, preserving first-seen order", async () => {
    vi.mocked(listProcesses).mockReturnValue([
      { pid: 1, name: "Cursor" },
      { pid: 2, name: "Cursor" },
      { pid: 3, name: "Discord" },
      { pid: 4, name: "  " },
      { pid: 5, name: "Slack" },
    ]);
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.openApps).toEqual(["Cursor", "Discord", "Slack"]);
  });

  it("caps openApps at 50 entries even when listProcesses returns more", async () => {
    vi.mocked(listProcesses).mockReturnValue(
      Array.from({ length: 120 }, (_, i) => ({ pid: i + 1, name: `proc-${i}` })),
    );
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.openApps).toHaveLength(50);
    expect(ctx.openApps[0]).toBe("proc-0");
    expect(ctx.openApps[49]).toBe("proc-49");
  });
});

describe("VisionContextProvider — focused window", () => {
  it("uses the bbox-bearing focused window from the current scene when ComputerUseService is registered", async () => {
    const { runtime } = makeRuntime({ scene: makeScene() });
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.focusedWindow).toEqual({
      app: "Cursor",
      title: "vision-context-provider.ts — eliza",
      bbox: [0, 0, 1440, 900],
    });
  });

  it("falls back to listWindows() with bbox=null when no scene is available", async () => {
    vi.mocked(listWindows).mockReturnValue([
      { id: "w1", title: "Inbox — Mail", app: "Mail" },
    ]);
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.focusedWindow).toEqual({
      app: "Mail",
      title: "Inbox — Mail",
      bbox: null,
    });
  });

  it("returns null focusedWindow when neither scene nor windows produce a hit", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.focusedWindow).toBeNull();
  });
});

describe("VisionContextProvider — recent actions", () => {
  it("appends actions and exposes them in insertion order", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    provider.noteAction("click");
    provider.noteAction("type");
    const ctx = await provider.getContext();
    expect(ctx.recentActions.map((a) => a.action)).toEqual(["click", "type"]);
    for (const entry of ctx.recentActions) {
      expect(typeof entry.ts).toBe("number");
      expect(entry.ts).toBeGreaterThan(0);
    }
  });

  it("rejects empty action labels rather than silently swallowing", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    expect(() => provider.noteAction("")).toThrow(/non-empty action label/);
  });

  it("retains only the 10 most recent actions (ring buffer)", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    for (let i = 0; i < 15; i++) provider.noteAction(`a${i}`);
    const ctx = await provider.getContext();
    expect(ctx.recentActions).toHaveLength(10);
    expect(ctx.recentActions[0]?.action).toBe("a5");
    expect(ctx.recentActions[9]?.action).toBe("a14");
  });

  it("returns a defensive copy of the recent-actions buffer", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    provider.noteAction("click");
    const ctx = await provider.getContext();
    ctx.recentActions.length = 0;
    const second = await provider.getContext();
    expect(second.recentActions).toHaveLength(1);
  });
});

describe("VisionContextProvider — task goal", () => {
  it("returns the cached task goal verbatim", async () => {
    const { runtime } = makeRuntime({ taskGoal: "draft a release email" });
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.currentTaskGoal).toBe("draft a release email");
  });

  it("returns null when the cache key is unset", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    const ctx = await provider.getContext();
    expect(ctx.currentTaskGoal).toBeNull();
  });

  it("treats whitespace-only and non-string cache values as null", async () => {
    const { runtime: r1 } = makeRuntime({ taskGoal: "   " });
    expect((await new VisionContextProvider(r1).getContext()).currentTaskGoal).toBeNull();

    const { runtime: r2 } = makeRuntime({ taskGoal: 42 });
    expect((await new VisionContextProvider(r2).getContext()).currentTaskGoal).toBeNull();
  });
});

describe("VisionContextProvider — lifecycle", () => {
  it("clears the recent-actions buffer on stop()", async () => {
    const { runtime } = makeRuntime();
    const provider = new VisionContextProvider(runtime);
    provider.noteAction("click");
    await provider.stop();
    const ctx = await provider.getContext();
    expect(ctx.recentActions).toEqual([]);
  });
});
