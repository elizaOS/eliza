/**
 * Scene serialization tests pin the lossless JSON fence that the scene
 * provider injects into prompts.
 */
import { describe, expect, it } from "vitest";
import type { Scene, SceneApp, SceneOcrBox } from "./scene-types.js";
import { serializeSceneForPrompt } from "./serialize.js";

const baseScene = (o: Partial<Scene> = {}): Scene => ({
  timestamp: 1000,
  displays: [
    {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "D0",
    },
  ],
  focused_window: null,
  apps: [],
  ocr: [],
  ax: [],
  vlm_scene: null,
  vlm_elements: null,
  ...o,
});

/** Parse the fenced-JSON output, asserting the ```json … ``` framing. */
function parseFenced(out: string): Record<string, unknown> {
  expect(out.startsWith("```json\n")).toBe(true);
  expect(out.endsWith("\n```")).toBe(true);
  const body = out.slice("```json\n".length, out.length - "\n```".length);
  return JSON.parse(body);
}

const ocrBox = (seq: number, conf: number, displayId = 0): SceneOcrBox => ({
  id: `t${displayId}-${seq}`,
  text: `line ${seq}`,
  bbox: [0, 0, 10, 10],
  conf,
  displayId,
});

describe("serializeSceneForPrompt", () => {
  it("emits valid fenced JSON", () => {
    const parsed = parseFenced(serializeSceneForPrompt(baseScene()));
    expect(parsed.timestamp).toBe(1000);
    expect(parsed).not.toHaveProperty("truncation");
  });

  it("keeps every OCR box even when a legacy cap option is passed", () => {
    const ocr = Array.from({ length: 30 }, (_, i) => ocrBox(i, i / 100));
    const parsed = parseFenced(
      serializeSceneForPrompt(baseScene({ ocr }), { ocrTopN: 3 }),
    );
    const kept = parsed.ocr as Array<{ conf: number }>;
    expect(kept).toHaveLength(30);
    expect(kept[0]?.conf).toBe(0.29);
    expect(kept.at(-1)?.conf).toBe(0);
  });

  it("rounds OCR confidence to 3 decimals", () => {
    const parsed = parseFenced(
      serializeSceneForPrompt(baseScene({ ocr: [ocrBox(0, 0.123456)] })),
    );
    expect((parsed.ocr as Array<{ conf: number }>)[0]?.conf).toBe(0.123);
  });

  it("keeps every AX node while ordering the focused display first", () => {
    const ax = [
      {
        id: "d0a",
        role: "button",
        bbox: [0, 0, 1, 1],
        actions: [],
        displayId: 0,
      },
      {
        id: "d0b",
        role: "button",
        bbox: [0, 0, 1, 1],
        actions: [],
        displayId: 0,
      },
      {
        id: "d1a",
        role: "link",
        bbox: [0, 0, 1, 1],
        actions: [],
        displayId: 1,
      },
      {
        id: "d1b",
        role: "link",
        bbox: [0, 0, 1, 1],
        actions: [],
        displayId: 1,
      },
    ];
    const parsed = parseFenced(
      serializeSceneForPrompt(
        baseScene({
          ax,
          focused_window: {
            app: "X",
            pid: 1,
            bounds: [0, 0, 1, 1],
            title: "t",
            displayId: 1,
          },
        }),
        { axMax: 2 },
      ),
    );
    const keptAx = parsed.ax as Array<{ displayId: number }>;
    expect(keptAx).toHaveLength(4);
    expect(keptAx.map((n) => n.displayId)).toEqual([1, 1, 0, 0]);
  });

  it("orders apps while retaining every app and window", () => {
    const win = (id: string) => ({
      id,
      title: `w-${id}`,
      bounds: [0, 0, 1, 1] as [number, number, number, number],
      displayId: 0,
    });
    const app = (name: string, windows: number): SceneApp => ({
      name,
      pid: 1,
      windows: Array.from({ length: windows }, (_, i) => win(`${name}-${i}`)),
    });
    const apps = [
      app("app-bg", 0),
      app("app-zebra", 2),
      app("app-mid", 1),
      app("app-alpha", 2),
    ];
    const parsed = parseFenced(
      serializeSceneForPrompt(baseScene({ apps }), {
        appMax: 2,
        appTopWindows: 1,
      }),
    );
    const keptApps = parsed.apps as Array<{
      name: string;
      window_count: number;
      windows: unknown[];
    }>;
    expect(keptApps).toHaveLength(4);
    expect(keptApps.map((a) => a.name)).toEqual([
      "app-alpha",
      "app-zebra",
      "app-mid",
      "app-bg",
    ]);
    expect(keptApps[0]?.window_count).toBe(2);
    expect(keptApps[0]?.windows).toHaveLength(2);
  });
});
