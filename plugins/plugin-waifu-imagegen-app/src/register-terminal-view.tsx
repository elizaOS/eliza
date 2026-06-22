/**
 * Register the image-gen view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the image-gen `tui` modality render for real in the
 * terminal (the unified {@link ImageGenSpatialView}) rather than only navigating
 * a GUI shell. A module-level snapshot lets a host push live state; with no host
 * data it defaults to an empty prompt with no result.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ImageGenSnapshot,
  ImageGenSpatialView,
} from "./ImageGenSpatialView.tsx";

const EMPTY: ImageGenSnapshot = {
  prompt: "",
  aspect: "1:1",
  model: "openai/gpt-image-2/text-to-image",
  busy: false,
  error: null,
  result: null,
  promptValid: false,
  canGenerate: false,
  markupPct: null,
};

let current: ImageGenSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setImageGenTerminalSnapshot(next: ImageGenSnapshot): void {
  current = next;
}

/** Register the image-gen terminal view; returns an unregister function. */
export function registerImageGenTerminalView(): () => void {
  return registerSpatialTerminalView("waifu-imagegen", () =>
    createElement(ImageGenSpatialView, { snapshot: current }),
  );
}
