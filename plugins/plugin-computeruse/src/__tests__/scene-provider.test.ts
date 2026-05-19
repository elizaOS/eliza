/**
 * Provider integration test for the `scene` provider.
 *
 * The provider is supposed to:
 *   1. Read `service.getCurrentScene()` first.
 *   2. If no scene yet, force a `refreshScene("agent-turn")`.
 *   3. Serialize the result via `serializeSceneForPrompt` and emit both
 *      `text` (fenced JSON for the prompt) and `data.scene` (the full
 *      Scene for downstream pieces like WS7).
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { sceneProvider } from "../providers/scene.js";
import type {
  Scene,
  SceneApp,
  SceneAxNode,
  SceneOcrBox,
} from "../scene/scene-types.js";

function makeScene(): Scene {
  const ocr: SceneOcrBox[] = [
    {
      id: "t0-1",
      text: "Hello",
      bbox: [10, 20, 100, 24],
      conf: 0.95,
      displayId: 0,
    },
    {
      id: "t0-2",
      text: "World",
      bbox: [10, 60, 100, 24],
      conf: 0.83,
      displayId: 0,
    },
  ];
  const ax: SceneAxNode[] = [
    {
      id: "a0-1",
      role: "button",
      label: "Submit",
      bbox: [10, 100, 80, 30],
      actions: ["press"],
      displayId: 0,
    },
  ];
  const apps: SceneApp[] = [
    {
      name: "Firefox",
      pid: 1234,
      windows: [
        {
          id: "w1",
          title: "Eliza Dashboard",
          bounds: [0, 0, 1920, 1080],
          displayId: 0,
        },
      ],
    },
  ];
  return {
    timestamp: 1_700_000_000_000,
    displays: [
      {
        id: 0,
        bounds: [0, 0, 1920, 1080],
        scaleFactor: 1,
        primary: true,
        name: "fake-1",
      },
    ],
    focused_window: {
      app: "Firefox",
      pid: 1234,
      bounds: [0, 0, 1920, 1080],
      title: "Eliza Dashboard",
      displayId: 0,
    },
    apps,
    ocr,
    ax,
    vlm_scene: null,
    vlm_elements: null,
  };
}

function makeRuntime(
  scene: Scene | null,
  refresh?: () => Promise<Scene>,
): IAgentRuntime {
  const service = {
    getCurrentScene: () => scene,
    refreshScene:
      refresh ??
      (async () => {
        throw new Error("no scene available");
      }),
  };
  return {
    getService: (name: string) =>
      name === "computeruse" ? (service as unknown) : undefined,
  } as unknown as IAgentRuntime;
}

const dummyMessage: Memory = {} as Memory;
const dummyState: State = {} as State;

describe("sceneProvider", () => {
  it("returns parsed text + data for an existing scene", async () => {
    const scene = makeScene();
    const result = await sceneProvider.get(
      makeRuntime(scene),
      dummyMessage,
      dummyState,
    );
    expect(result.text).toContain("```json");
    expect(result.text).toContain('"id": "t0-1"');
    expect(result.text).toContain("Firefox");
    expect(result.data?.scene?.ocr).toHaveLength(2);
    expect(result.values?.sceneDisplayCount).toBe(1);
    expect(result.values?.sceneOcrCount).toBe(2);
    expect(result.values?.sceneAxCount).toBe(1);
  });

  it("forces refresh when no scene is cached", async () => {
    const scene = makeScene();
    let calls = 0;
    const refresh = async (): Promise<Scene> => {
      calls += 1;
      return scene;
    };
    const result = await sceneProvider.get(
      makeRuntime(null, refresh),
      dummyMessage,
      dummyState,
    );
    expect(calls).toBe(1);
    expect(result.text).toContain('"id": "t0-1"');
  });

  it("returns empty when the service is missing", async () => {
    const runtime = {
      getService: () => undefined,
    } as unknown as IAgentRuntime;
    const result = await sceneProvider.get(runtime, dummyMessage, dummyState);
    expect(result.text).toBe("");
  });

  it("returns empty when refresh fails and no scene is cached", async () => {
    const runtime = makeRuntime(null, async () => {
      throw new Error("boom");
    });
    const result = await sceneProvider.get(runtime, dummyMessage, dummyState);
    expect(result.text).toBe("");
  });
});
