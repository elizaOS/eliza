import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { Scene } from "../scene/scene-types.js";
import {
  VISION_CONTEXT_SERVICE_TYPE,
  VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
  VisionContextProvider,
} from "../services/vision-context-provider.js";

function makeScene(): Scene {
  return {
    timestamp: 1_700_000_000_000,
    displays: [
      {
        id: 0,
        bounds: [0, 0, 1920, 1080],
        scaleFactor: 1,
        primary: true,
        name: "display-1",
      },
    ],
    focused_window: {
      app: "Milady",
      pid: 123,
      bounds: [10, 20, 800, 600],
      title: "Chat",
      displayId: 0,
    },
    apps: [
      {
        name: "Milady",
        pid: 123,
        windows: [
          {
            id: "w1",
            title: "Chat",
            bounds: [10, 20, 800, 600],
            displayId: 0,
          },
        ],
      },
      { name: "background-only", pid: 456, windows: [] },
    ],
    ocr: [],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

describe("VisionContextProvider", () => {
  it("registers the service type consumed by plugin-vision", () => {
    expect(VisionContextProvider.serviceType).toBe(VISION_CONTEXT_SERVICE_TYPE);
  });

  it("returns compact scene and action context from computeruse", async () => {
    const scene = makeScene();
    const runtime = {
      getService: (name: string) =>
        name === "computeruse"
          ? {
              getCurrentScene: () => scene,
              getRecentActions: () => [
                { action: "click", timestamp: 42, success: true },
              ],
            }
          : undefined,
      getCache: async (key: string) =>
        key === VISION_CONTEXT_TASK_GOAL_CACHE_KEY
          ? "finish local voice"
          : undefined,
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;

    const provider = new VisionContextProvider(runtime);
    await expect(provider.getContext()).resolves.toEqual({
      openApps: ["Milady"],
      focusedWindow: {
        app: "Milady",
        title: "Chat",
        bbox: [10, 20, 800, 600],
      },
      recentActions: [{ action: "click", ts: 42 }],
      currentTaskGoal: "finish local voice",
    });
  });

  it("refreshes the scene when no current scene is cached", async () => {
    const scene = makeScene();
    let refreshMode: string | undefined;
    const runtime = {
      getService: () => ({
        getCurrentScene: () => null,
        refreshScene: async (mode: string) => {
          refreshMode = mode;
          return scene;
        },
        getRecentActions: () => [],
      }),
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;

    const provider = new VisionContextProvider(runtime);
    const context = await provider.getContext();
    expect(refreshMode).toBe("agent-turn");
    expect(context.focusedWindow?.app).toBe("Milady");
  });

  it("returns empty context when computeruse is not registered", async () => {
    const runtime = {
      getService: () => undefined,
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;
    const provider = new VisionContextProvider(runtime);
    await expect(provider.getContext()).resolves.toEqual({
      openApps: [],
      focusedWindow: null,
      recentActions: [],
      currentTaskGoal: null,
    });
  });
});
