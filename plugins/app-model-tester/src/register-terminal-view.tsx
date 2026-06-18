/**
 * Register the model-tester view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the model tester's `viewType: "tui"` declaration render
 * for real in the terminal (the unified {@link ModelTesterSpatialView}) rather
 * than only navigating a GUI shell. A module-level snapshot lets a host push
 * live probe data; with no host it defaults to the 8 idle probes.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ModelTesterProbeId,
  type ModelTesterProbeRow,
  type ModelTesterSnapshot,
  ModelTesterSpatialView,
} from "./components/ModelTesterSpatialView.tsx";

const DEFAULT_PROMPT =
  "Say exactly one short sentence about the Eliza-1 model tester working.";

const PROBE_DEFS: ReadonlyArray<{
  id: ModelTesterProbeId;
  label: string;
  modelType: string | null;
}> = [
  { id: "text-small", label: "Text", modelType: "TEXT_SMALL" },
  { id: "text-large", label: "Stream", modelType: "TEXT_LARGE" },
  { id: "embedding", label: "Embedding", modelType: "TEXT_EMBEDDING" },
  { id: "text-to-speech", label: "Voice", modelType: "TEXT_TO_SPEECH" },
  { id: "transcription", label: "Transcription", modelType: "TRANSCRIPTION" },
  { id: "vad", label: "Activity", modelType: null },
  { id: "image-description", label: "Vision", modelType: "IMAGE_DESCRIPTION" },
  { id: "image", label: "Image", modelType: "IMAGE" },
];

function emptyProbes(): ModelTesterProbeRow[] {
  return PROBE_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    modelType: def.modelType,
    // VAD is pure JS and always available; the rest start unknown until status.
    available: def.id === "vad",
    running: false,
  }));
}

const EMPTY: ModelTesterSnapshot = {
  prompt: DEFAULT_PROMPT,
  probes: emptyProbes(),
  readyCount: 1,
  runningCount: 0,
  completeCount: 0,
};

let current: ModelTesterSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setModelTesterTerminalSnapshot(
  next: ModelTesterSnapshot,
): void {
  current = next;
}

/** Register the model-tester terminal view; returns an unregister function. */
export function registerModelTesterTerminalView(): () => void {
  return registerSpatialTerminalView("model-tester", () =>
    createElement(ModelTesterSpatialView, { snapshot: current }),
  );
}
