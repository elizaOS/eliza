/**
 * In-window dynamic-view canvas for kiosk shell mode.
 *
 * In kiosk mode the OS runs a single fullscreen toplevel under a single-window
 * compositor, so dynamic views MUST NOT open separate native windows. This
 * canvas implements the same {@link DynamicViewCanvas} contract the
 * {@link DynamicViewSessionManager} expects, but instead of constructing a
 * `BrowserWindow` it pushes `kioskViewEvent` messages to the kiosk renderer,
 * which mounts each view as an in-canvas surface on the `KioskShell`.
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import type { SendToWebview } from "../types.js";

interface KioskCanvasWindowOptions {
  url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  title?: string;
  transparent?: boolean;
  alwaysOnTop?: boolean;
}

export type KioskViewEvent =
  | {
      kind: "mount";
      windowId: string;
      url: string;
      title: string;
      width: number;
      height: number;
      alwaysOnTop: boolean;
    }
  | { kind: "unmount"; windowId: string }
  | { kind: "a2ui"; windowId: string; payload: JsonValue };

/** Renderer-bound message channel name for kiosk in-window view events. */
export const KIOSK_VIEW_EVENT_MESSAGE = "kioskViewEvent";

let kioskCanvasCounter = 0;

/**
 * Canvas that renders dynamic views in-window on the kiosk surface. Each
 * "window" is a logical surface mounted by the renderer (a positioned
 * iframe/webview / DOM panel), not an OS toplevel.
 */
export class KioskCanvas {
  private readonly sendToWebview: SendToWebview;
  private readonly windowIds = new Set<string>();

  constructor(sendToWebview: SendToWebview) {
    this.sendToWebview = sendToWebview;
  }

  async createWindow(
    options: KioskCanvasWindowOptions,
  ): Promise<{ id: string }> {
    const id = `kiosk-view_${++kioskCanvasCounter}`;
    this.windowIds.add(id);
    const event: KioskViewEvent = {
      kind: "mount",
      windowId: id,
      url: options.url ?? "",
      title: options.title ?? "View",
      width: options.width ?? 760,
      height: options.height ?? 520,
      alwaysOnTop: options.alwaysOnTop === true,
    };
    this.sendToWebview(KIOSK_VIEW_EVENT_MESSAGE, event);
    return { id };
  }

  async destroyWindow(options: { id: string }): Promise<void> {
    this.windowIds.delete(options.id);
    const event: KioskViewEvent = { kind: "unmount", windowId: options.id };
    this.sendToWebview(KIOSK_VIEW_EVENT_MESSAGE, event);
  }

  async a2uiPush(options: { id: string; payload: JsonValue }): Promise<void> {
    const event: KioskViewEvent = {
      kind: "a2ui",
      windowId: options.id,
      payload: options.payload,
    };
    this.sendToWebview(KIOSK_VIEW_EVENT_MESSAGE, event);
  }
}
