/** Wires app-scoped capture, registered visual grounding, and guarded physical fallback to existing platform seams. */

import {
  getCoordOcrProvider,
  getSetOfMarksProvider,
} from "../mobile/ocr-provider.js";
import { captureDisplayRegion } from "../platform/capture.js";
import { listDisplays } from "../platform/displays.js";
import { driverClick, driverScroll } from "../platform/driver.js";
import type {
  AppActionRequest,
  AppControlGrounder,
  AppElementBounds,
  AppState,
  AppStateCapture,
  NativeAppSnapshot,
  VisualGroundingMatch,
} from "./types.js";

function displayForBounds(bounds: AppElementBounds) {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return listDisplays().find(
    ({ bounds: [x, y, width, height] }) =>
      centerX >= x &&
      centerX < x + width &&
      centerY >= y &&
      centerY < y + height,
  );
}

export class WindowRegionCapture implements AppStateCapture {
  async capture(snapshot: NativeAppSnapshot): Promise<{
    screenshot: string;
    displayId: number;
    bounds: AppElementBounds;
  } | null> {
    const bounds = snapshot.focusedWindowBounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const display = displayForBounds(bounds);
    if (!display) return null;
    const local = {
      x: Math.max(0, bounds.x - display.bounds[0]),
      y: Math.max(0, bounds.y - display.bounds[1]),
      width: Math.min(bounds.width, display.bounds[2]),
      height: Math.min(bounds.height, display.bounds[3]),
    };
    const capture = await captureDisplayRegion(display.id, local);
    return {
      screenshot: capture.frame.toString("base64"),
      displayId: display.id,
      bounds,
    };
  }
}

function requestedElement(state: AppState, request: AppActionRequest) {
  if (request.element_index === undefined) return undefined;
  return state.elements[request.element_index - 1];
}

function centerDistance(
  bounds: AppElementBounds,
  center: readonly [number, number],
): number {
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  return Math.hypot(x - center[0], y - center[1]);
}

export class RegisteredVisualGrounder implements AppControlGrounder {
  async ground(
    state: AppState,
    request: AppActionRequest,
  ): Promise<VisualGroundingMatch | null> {
    if (
      !state.screenshot ||
      !state.screenshotBounds ||
      state.displayId === undefined
    ) {
      return null;
    }
    const element = requestedElement(state, request);
    if (!element?.bounds) return null;
    const pngBytes = Buffer.from(state.screenshot, "base64");
    const sourceX = state.screenshotBounds.x;
    const sourceY = state.screenshotBounds.y;
    const som = getSetOfMarksProvider();
    if (som) {
      const result = await som.describe({
        displayId: String(state.displayId),
        sourceX,
        sourceY,
        pngBytes,
      });
      const match = result.marks
        .map((mark) => ({
          mark,
          distance: centerDistance(
            element.bounds as AppElementBounds,
            mark.center,
          ),
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (match) {
        return {
          mode: "set_of_marks",
          displayId: state.displayId,
          x: match.mark.center[0],
          y: match.mark.center[1],
        };
      }
    }
    const ocr = getCoordOcrProvider();
    if (!ocr) return null;
    const result = await ocr.describe({
      displayId: String(state.displayId),
      sourceX,
      sourceY,
      pngBytes,
    });
    const normalizedLabel = element.label?.trim().toLocaleLowerCase();
    const candidates = normalizedLabel
      ? result.blocks.filter((block) =>
          block.text.toLocaleLowerCase().includes(normalizedLabel),
        )
      : result.blocks;
    const match = candidates
      .map((block) => ({
        block,
        distance: centerDistance(element.bounds as AppElementBounds, [
          block.bbox.x + block.bbox.width / 2,
          block.bbox.y + block.bbox.height / 2,
        ]),
      }))
      .sort((a, b) => a.distance - b.distance)[0];
    return match
      ? {
          mode: "ocr",
          displayId: state.displayId,
          x: match.block.bbox.x + match.block.bbox.width / 2,
          y: match.block.bbox.y + match.block.bbox.height / 2,
        }
      : null;
  }
}

export const guardedPhysicalPointer = {
  click: driverClick,
  scroll: driverScroll,
};
