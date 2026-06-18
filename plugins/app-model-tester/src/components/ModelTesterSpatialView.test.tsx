import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ModelTesterSnapshot,
  ModelTesterSpatialView,
} from "./ModelTesterSpatialView.tsx";

const snapshot: ModelTesterSnapshot = {
  prompt: "Say one short sentence about the model tester.",
  readyCount: 6,
  runningCount: 1,
  completeCount: 2,
  imageDataUrl: null,
  audioLoaded: true,
  probes: [
    {
      id: "text-small",
      label: "Text",
      modelType: "TEXT_SMALL",
      available: true,
      running: false,
      result: { ok: true, durationMs: 412, output: "hello from text-small" },
    },
    {
      id: "text-large",
      label: "Stream",
      modelType: "TEXT_LARGE",
      available: true,
      running: true,
    },
    {
      id: "embedding",
      label: "Embedding",
      modelType: "TEXT_EMBEDDING",
      available: true,
      running: false,
    },
    {
      id: "text-to-speech",
      label: "Voice",
      modelType: "TEXT_TO_SPEECH",
      available: true,
      running: false,
      result: {
        ok: true,
        durationMs: 900,
        audioSrc: "data:audio/wav;base64,AA",
      },
    },
    {
      id: "transcription",
      label: "Transcription",
      modelType: "TRANSCRIPTION",
      available: false,
      running: false,
      result: { ok: false, output: "no provider" },
    },
    {
      id: "vad",
      label: "Activity",
      modelType: null,
      available: true,
      running: false,
    },
    {
      id: "image-description",
      label: "Vision",
      modelType: "IMAGE_DESCRIPTION",
      available: true,
      running: false,
    },
    {
      id: "image",
      label: "Image",
      modelType: "IMAGE",
      available: true,
      running: false,
    },
  ],
};

const view = <ModelTesterSpatialView snapshot={snapshot} />;

describe("ModelTesterSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Model Tester");
      expect(flat).toContain("ready");
      expect(flat).toContain("Text");
      expect(flat).toContain("Run all");
      expect(flat).toContain("Activity");
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Model Tester");
      expect(html).toContain("Text");
      expect(html).toContain('data-agent-id="run-all"');
      expect(html).toContain('data-agent-id="refresh-status"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "model-tester-test",
      () => view,
    );
    try {
      const component = getTerminalView("model-tester-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Model Tester");
    } finally {
      unregister();
    }
  });
});
