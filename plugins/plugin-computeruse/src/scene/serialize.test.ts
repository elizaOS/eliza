/**
 * Scene serialization tests pin the bounded JSON fence that the scene
 * provider injects into prompts while the provider data retains the full Scene.
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

  it("keeps the highest-confidence OCR boxes within the prompt cap", () => {
    const ocr = Array.from({ length: 30 }, (_, i) => ocrBox(i, i / 100));
    const parsed = parseFenced(
      serializeSceneForPrompt(baseScene({ ocr }), { ocrTopN: 3 }),
    );
    const kept = parsed.ocr as Array<{ conf: number }>;
    expect(kept).toHaveLength(3);
    expect(kept[0]?.conf).toBe(0.29);
    expect(kept.at(-1)?.conf).toBe(0.27);
    expect(parsed.projection).toMatchObject({
      bounded: true,
      full_scene_available_in_provider_data: true,
      omitted_counts: { ocr: 27 },
    });
  });

  it("rounds OCR confidence to 3 decimals", () => {
    const parsed = parseFenced(
      serializeSceneForPrompt(baseScene({ ocr: [ocrBox(0, 0.123456)] })),
    );
    expect((parsed.ocr as Array<{ conf: number }>)[0]?.conf).toBe(0.123);
  });

  it("keeps focused-display AX nodes first within the prompt cap", () => {
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
    expect(keptAx).toHaveLength(2);
    expect(keptAx.map((n) => n.displayId)).toEqual([1, 1]);
  });

  it("orders apps and bounds applications and windows", () => {
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
    expect(keptApps).toHaveLength(2);
    expect(keptApps.map((a) => a.name)).toEqual(["app-alpha", "app-zebra"]);
    expect(keptApps[0]?.window_count).toBe(2);
    expect(keptApps[0]?.windows).toHaveLength(1);
    expect(parsed.projection).toMatchObject({
      omitted_counts: { apps: 2, windows: 3 },
    });
  });

  it("bounds individual model-visible strings", () => {
    const parsed = parseFenced(
      serializeSceneForPrompt(
        baseScene({ ocr: [{ ...ocrBox(1, 1), text: "x".repeat(200) }] }),
        { textMaxChars: 40 },
      ),
    );
    const text = (parsed.ocr as Array<{ text: string }>)[0]?.text ?? "";
    expect(text.length).toBe(40);
    expect(text.endsWith("…")).toBe(true);
  });

  it("keeps a pathological desktop scene within a practical prompt budget", () => {
    const long = "visible desktop text ".repeat(200);
    const parsedScene = baseScene({
      apps: Array.from({ length: 200 }, (_, appIndex) => ({
        name: `${long}-${appIndex}`,
        pid: appIndex,
        windows: Array.from({ length: 40 }, (_, windowIndex) => ({
          id: `${appIndex}-${windowIndex}`,
          title: `${long}-${windowIndex}`,
          bounds: [0, 0, 10, 10],
          displayId: 0,
        })),
      })),
      ocr: Array.from({ length: 2_000 }, (_, index) => ({
        ...ocrBox(index, 1 - index / 10_000),
        text: `${long}-${index}`,
      })),
      ax: Array.from({ length: 2_000 }, (_, index) => ({
        id: `ax-${index}`,
        role: "button",
        label: `${long}-${index}`,
        bbox: [0, 0, 10, 10],
        actions: Array.from(
          { length: 100 },
          (_, action) => `${long}-${action}`,
        ),
        displayId: 0,
      })),
    });
    const output = serializeSceneForPrompt(parsedScene);
    const parsed = parseFenced(output);
    expect(output.length).toBeLessThan(200_000);
    expect(parsed.projection).toMatchObject({
      bounded: true,
      source_counts: { apps: 200, windows: 8_000, ocr: 2_000, ax: 2_000 },
      retained_counts: { apps: 32, windows: 128, ocr: 64, ax: 128 },
    });
  });

  it("structurally redacts OCR and labels inside secure accessibility fields", () => {
    const parsed = parseFenced(
      serializeSceneForPrompt(
        baseScene({
          ocr: [
            {
              ...ocrBox(1, 0.99),
              text: "owner-secret-value",
              bbox: [100, 100, 80, 30],
            },
            { ...ocrBox(2, 0.98), text: "Safe label", bbox: [0, 0, 20, 20] },
          ],
          ax: [
            {
              id: "secure-1",
              role: "AXSecureTextField",
              label: "owner-secret-value",
              bbox: [90, 90, 120, 50],
              actions: ["setValue"],
              displayId: 0,
            },
          ],
        }),
      ),
    );
    expect(JSON.stringify(parsed)).not.toContain("owner-secret-value");
    expect(parsed.ocr).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "[REDACTED_SECURE_FIELD]" }),
        expect.objectContaining({ text: "Safe label" }),
      ]),
    );
    expect(parsed.redactions).toEqual([
      expect.objectContaining({ kind: "secure_field", displayId: 0 }),
    ]);
  });
});
