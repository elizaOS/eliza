/**
 * Synchronizes the detached chat overlay with a small set of stable native
 * window envelopes. Renderer springs animate inside those envelopes while the
 * native host owns display clamping, placement, and settled hit-test bounds.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import { invokeDesktopBridgeRequest } from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";

export interface ChatOverlayMaterialSize {
  width: number;
  height: number;
}

export type ChatOverlayWindowSizeClass = "resting" | "input" | "sheet";

interface ChatOverlayWindowSizeBridge {
  setBottomBarSize: (size: ChatOverlayMaterialSize) => Promise<void>;
  onFailure: (error: unknown) => void;
}

export interface ChatOverlayWindowSizeCoordinator {
  cancel: () => void;
  schedule: (size: ChatOverlayMaterialSize) => void;
  whenIdle: () => Promise<void>;
}

export const CHAT_OVERLAY_RESTING_WINDOW_WIDTH = 96;
export const CHAT_OVERLAY_RESTING_WINDOW_HEIGHT = 56;
export const CHAT_OVERLAY_STAGE_WIDTH = 600;
export const CHAT_OVERLAY_STAGE_HEIGHT = 820;
export const CHAT_OVERLAY_AUTH_WINDOW_WIDTH = 240;
export const CHAT_OVERLAY_AUTH_WINDOW_HEIGHT = 56;

function normalizeMaterialSize(
  size: ChatOverlayMaterialSize,
): ChatOverlayMaterialSize {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new RangeError(
      "[chat-overlay-window] material size must be positive and finite",
    );
  }
  return {
    width: Math.max(1, Math.ceil(size.width)),
    height: Math.max(1, Math.ceil(size.height)),
  };
}

/** Converts the transformed panel rect into the exact native hit-test size. */
export function resolveChatOverlayMaterialSize(
  rect: {
    width: number;
    height: number;
  },
  pilled = false,
): ChatOverlayMaterialSize {
  if (pilled) {
    return {
      width: CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
      height: CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
    };
  }
  return normalizeMaterialSize({
    width: Math.max(CHAT_OVERLAY_RESTING_WINDOW_WIDTH, rect.width),
    height: Math.max(CHAT_OVERLAY_RESTING_WINDOW_HEIGHT, rect.height),
  });
}

function sizesEqual(
  left: ChatOverlayMaterialSize | null,
  right: ChatOverlayMaterialSize,
): boolean {
  return left?.width === right.width && left.height === right.height;
}

/** Reads the native host's canonical logical stage dimensions from its URL. */
export function readChatOverlayStageSize(
  search = typeof window === "undefined" ? "" : window.location.search,
): ChatOverlayMaterialSize {
  const params = new URLSearchParams(search);
  const width = Number(params.get("chatOverlayStageWidth"));
  const height = Number(params.get("chatOverlayStageHeight"));
  return {
    width:
      Number.isFinite(width) && width > 0 ? width : CHAT_OVERLAY_STAGE_WIDTH,
    height:
      Number.isFinite(height) && height > 0
        ? height
        : CHAT_OVERLAY_STAGE_HEIGHT,
  };
}

/** Reads the host-owned sign-in chip dimensions from the renderer URL. */
export function readChatOverlayAuthSize(
  search = typeof window === "undefined" ? "" : window.location.search,
): ChatOverlayMaterialSize {
  const params = new URLSearchParams(search);
  const width = Number(params.get("chatOverlayAuthWidth"));
  const height = Number(params.get("chatOverlayAuthHeight"));
  return {
    width:
      Number.isFinite(width) && width > 0
        ? width
        : CHAT_OVERLAY_AUTH_WINDOW_WIDTH,
    height:
      Number.isFinite(height) && height > 0
        ? height
        : CHAT_OVERLAY_AUTH_WINDOW_HEIGHT,
  };
}

/** Creates a serialized latest-request-wins native size queue. */
export function createChatOverlayWindowSizeCoordinator(
  bridge: ChatOverlayWindowSizeBridge,
): ChatOverlayWindowSizeCoordinator {
  let latestRevision = 0;
  let lastApplied: ChatOverlayMaterialSize | null = null;
  let tail: Promise<void> = Promise.resolve();

  const schedule = (requestedSize: ChatOverlayMaterialSize): void => {
    const size = normalizeMaterialSize(requestedSize);
    if (sizesEqual(lastApplied, size)) return;
    const revision = ++latestRevision;
    const operation = tail.then(async () => {
      if (revision !== latestRevision || sizesEqual(lastApplied, size)) return;
      await bridge.setBottomBarSize(size);
      if (revision === latestRevision) lastApplied = size;
    });
    // error-policy:J4 Native geometry failure becomes the visible action notice
    // supplied by the detached shell boundary.
    tail = operation.catch((error: unknown) => {
      if (revision === latestRevision) bridge.onFailure(error);
    });
  };

  return {
    cancel: () => {
      latestRevision += 1;
    },
    schedule,
    whenIdle: () => tail,
  };
}

/** Applies measured material size without duplicating native display geometry. */
export function useChatOverlayWindowSize(
  onFailure: (error: unknown) => void,
): (size: ChatOverlayMaterialSize) => void {
  const onFailureRef = useRef(onFailure);
  useEffect(() => {
    onFailureRef.current = onFailure;
  }, [onFailure]);

  const coordinator = useMemo(
    () =>
      createChatOverlayWindowSizeCoordinator({
        setBottomBarSize: async (size) => {
          await invokeDesktopBridgeRequest<void>({
            rpcMethod: "desktopSetBottomBarSize",
            ipcChannel: "desktop:setBottomBarSize",
            params: size,
          });
        },
        onFailure: (error) => onFailureRef.current(error),
      }),
    [],
  );

  useEffect(() => () => coordinator.cancel(), [coordinator]);

  return useCallback(
    (size: ChatOverlayMaterialSize) => {
      if (!isElectrobunRuntime()) return;
      coordinator.schedule(size);
    },
    [coordinator],
  );
}
