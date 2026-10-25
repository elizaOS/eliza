/**
 * Selects kiosk-capable view surfaces for the dedicated display canvas.
 */
import { useEffect, useState } from "react";
import { subscribeDesktopBridgeEvent } from "../../bridge/electrobun-rpc";

/**
 * One in-window dynamic-view surface mounted on the kiosk canvas. Mirrors the
 * `KioskViewEvent` "mount" payload emitted by the Electrobun-side KioskCanvas
 * when the agent opens a dynamic view in kiosk shell mode.
 */
export interface KioskViewSurface {
  windowId: string;
  url: string;
  title: string;
  width: number;
  height: number;
  alwaysOnTop: boolean;
}

type KioskViewEventPayload =
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
  | { kind: "a2ui"; windowId: string; payload: unknown };

function isKioskViewEvent(value: unknown): value is KioskViewEventPayload {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "mount" || kind === "unmount" || kind === "a2ui";
}

/**
 * Subscribes to the Electrobun `kioskViewEvent` channel and maintains the set
 * of dynamic-view surfaces the kiosk canvas should render in-window.
 *
 * In kiosk shell mode the OS runs a single fullscreen toplevel, so the
 * dynamic-view session manager mounts views as in-canvas surfaces (positioned
 * iframes) instead of opening native windows. This hook turns the bun-side
 * mount/unmount events into the list of surfaces the `KioskViewCanvas` renders.
 *
 * `a2ui` events are intentionally not forwarded here: each view loads its
 * initial state from its own entrypoint over the local agent, so the canvas
 * only reacts to `mount`/`unmount` events.
 */
export function useKioskViewSurfaces(): KioskViewSurface[] {
  const [surfaces, setSurfaces] = useState<KioskViewSurface[]>([]);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "kioskViewEvent",
      ipcChannel: "kiosk:viewEvent",
      listener: (payload) => {
        if (!isKioskViewEvent(payload)) return;
        if (payload.kind === "mount") {
          const next: KioskViewSurface = {
            windowId: payload.windowId,
            url: payload.url,
            title: payload.title,
            width: payload.width,
            height: payload.height,
            alwaysOnTop: payload.alwaysOnTop,
          };
          setSurfaces((current) => [
            ...current.filter((s) => s.windowId !== next.windowId),
            next,
          ]);
          return;
        }
        if (payload.kind === "unmount") {
          setSurfaces((current) =>
            current.filter((s) => s.windowId !== payload.windowId),
          );
        }
        // `a2ui` events carry agent-pushed view state. The view loads its
        // initial state from its own entrypoint over the local agent, so the
        // canvas does not need to forward the payload here.
      },
    });
  }, []);

  return surfaces;
}
