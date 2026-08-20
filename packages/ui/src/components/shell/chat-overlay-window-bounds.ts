/**
 * Keeps the desktop chat-overlay window inside the primary display work area
 * while serializing renderer-to-main bounds updates across rapid open/close
 * transitions.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import { invokeDesktopBridgeRequest } from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";

export interface ChatOverlayWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ChatOverlayDisplayInfo {
  workArea: ChatOverlayWindowBounds;
}

interface ChatOverlayWindowBoundsBridge {
  getWindowBounds: () => Promise<ChatOverlayWindowBounds | null>;
  getPrimaryDisplay: () => Promise<ChatOverlayDisplayInfo | null>;
  setWindowBounds: (bounds: ChatOverlayWindowBounds) => Promise<void>;
  onFailure: (error: unknown) => void;
}

export interface ChatOverlayWindowBoundsCoordinator {
  cancel: () => void;
  schedule: (overlayOpen: boolean) => void;
  whenIdle: () => Promise<void>;
}

export const CHAT_OVERLAY_RESTING_WINDOW_WIDTH = 48;
export const CHAT_OVERLAY_RESTING_WINDOW_HEIGHT = 6;
export const CHAT_OVERLAY_INPUT_WINDOW_HEIGHT = 64;
export const CHAT_OVERLAY_EXPANDED_WINDOW_WIDTH = 600;
export const CHAT_OVERLAY_EXPANDED_WINDOW_HEIGHT = 820;
export const CHAT_OVERLAY_STAGE_WIDTH = CHAT_OVERLAY_EXPANDED_WINDOW_WIDTH;
export const CHAT_OVERLAY_STAGE_HEIGHT = CHAT_OVERLAY_EXPANDED_WINDOW_HEIGHT;
export const CHAT_OVERLAY_AUTH_WINDOW_WIDTH = 240;
export const CHAT_OVERLAY_AUTH_WINDOW_HEIGHT = 56;

export interface ChatOverlayMaterialSize {
  width: number;
  height: number;
}

export type ChatOverlayWindowSizeClass = "resting" | "input" | "sheet";

/** Only a second Escape from the already-settled resting pill hides native UI. */
export function shouldHideRestingChatOverlay(
  key: string,
  sizeClass: ChatOverlayWindowSizeClass,
): boolean {
  return key === "Escape" && sizeClass === "resting";
}

/**
 * Returns the stable compact native envelope for the visible composer or the
 * final white-bar rest state. The renderer cannot measure a 64px composer
 * while its WKWebView is still clipped to the 6px resting host, so INPUT must
 * receive a real first frame instead of depending on ResizeObserver recovery.
 */
export function resolveChatOverlayCompactWindowSize(
  sizeClass: Extract<ChatOverlayWindowSizeClass, "resting" | "input">,
  stageSize: ChatOverlayMaterialSize,
): ChatOverlayMaterialSize {
  if (sizeClass === "input") {
    return {
      width: Math.max(CHAT_OVERLAY_RESTING_WINDOW_WIDTH, stageSize.width - 24),
      height: CHAT_OVERLAY_INPUT_WINDOW_HEIGHT,
    };
  }
  return {
    width: CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
    height: CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
  };
}

interface ChatOverlayWindowSizeBridge {
  setBottomBarSize: (size: ChatOverlayMaterialSize) => Promise<void>;
  onFailure: (error: unknown) => void;
}

export interface ChatOverlayWindowSizeCoordinator {
  cancel: () => void;
  schedule: (size: ChatOverlayMaterialSize) => void;
  whenIdle: () => Promise<void>;
}

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

/**
 * Converts the transformed panel rect into the exact native material size.
 * A pill-mode commit precedes its closing spring, so the final 48x6 geometry
 * cannot take over until that still-visible panel has actually reached rest.
 */
export function resolveChatOverlayMaterialSize(
  rect: ChatOverlayMaterialSize,
  pilled = false,
  openProgress = pilled ? 0 : 1,
): ChatOverlayMaterialSize {
  if (pilled && openProgress <= 0.001) {
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

function assertValidBounds(
  bounds: ChatOverlayWindowBounds,
  label: string,
): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new RangeError(`[chat-overlay-window] invalid ${label} bounds`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Computes a fully visible bottom-anchored frame for the requested state. */
export function computeChatOverlayWindowBounds(
  current: ChatOverlayWindowBounds,
  workArea: ChatOverlayWindowBounds,
  overlayOpen: boolean,
): ChatOverlayWindowBounds {
  assertValidBounds(current, "window");
  assertValidBounds(workArea, "work-area");

  const requestedHeight = overlayOpen
    ? CHAT_OVERLAY_EXPANDED_WINDOW_HEIGHT
    : CHAT_OVERLAY_RESTING_WINDOW_HEIGHT;
  const requestedWidth = overlayOpen
    ? CHAT_OVERLAY_EXPANDED_WINDOW_WIDTH
    : CHAT_OVERLAY_RESTING_WINDOW_WIDTH;
  const height = Math.min(requestedHeight, workArea.height);
  const width = Math.min(requestedWidth, workArea.width);
  const x = workArea.x + Math.round((workArea.width - width) / 2);
  const bottom = clamp(
    current.y + current.height,
    workArea.y + height,
    workArea.y + workArea.height,
  );

  return { x, y: bottom - height, width, height };
}

function boundsEqual(
  left: ChatOverlayWindowBounds,
  right: ChatOverlayWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Creates the serialized, latest-request-wins bounds-update queue. */
export function createChatOverlayWindowBoundsCoordinator(
  bridge: ChatOverlayWindowBoundsBridge,
): ChatOverlayWindowBoundsCoordinator {
  let latestRevision = 0;
  let tail: Promise<void> = Promise.resolve();

  const schedule = (overlayOpen: boolean): void => {
    const revision = ++latestRevision;
    const operation = tail.then(async () => {
      if (revision !== latestRevision) return;

      const [current, display] = await Promise.all([
        bridge.getWindowBounds(),
        bridge.getPrimaryDisplay(),
      ]);
      if (revision !== latestRevision) return;
      if (!current || !display) {
        throw new Error("[chat-overlay-window] desktop geometry unavailable");
      }

      const next = computeChatOverlayWindowBounds(
        current,
        display.workArea,
        overlayOpen,
      );
      if (boundsEqual(current, next)) return;
      await bridge.setWindowBounds(next);
    });

    // error-policy:J4 A rejected desktop geometry request becomes a visible
    // action notice through the hook's required onFailure callback.
    tail = operation.catch((error: unknown) => {
      if (revision === latestRevision) {
        bridge.onFailure(error);
      }
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

/** Applies desktop overlay bounds whenever the shared shell opens or closes. */
export function useChatOverlayWindowBounds(
  overlayOpen: boolean,
  onFailure: (error: unknown) => void,
): void {
  const onFailureRef = useRef(onFailure);
  useEffect(() => {
    onFailureRef.current = onFailure;
  }, [onFailure]);

  const coordinator = useMemo(
    () =>
      createChatOverlayWindowBoundsCoordinator({
        getWindowBounds: () =>
          invokeDesktopBridgeRequest<ChatOverlayWindowBounds>({
            rpcMethod: "desktopGetWindowBounds",
            ipcChannel: "desktop:getWindowBounds",
          }),
        getPrimaryDisplay: () =>
          invokeDesktopBridgeRequest<ChatOverlayDisplayInfo>({
            rpcMethod: "desktopGetPrimaryDisplay",
            ipcChannel: "desktop:getPrimaryDisplay",
          }),
        setWindowBounds: async (bounds) => {
          await invokeDesktopBridgeRequest<void>({
            rpcMethod: "desktopSetWindowBounds",
            ipcChannel: "desktop:setWindowBounds",
            params: bounds,
          });
        },
        onFailure: (error) => onFailureRef.current(error),
      }),
    [],
  );

  useEffect(() => {
    if (!isElectrobunRuntime()) return undefined;
    coordinator.schedule(overlayOpen);
    return () => coordinator.cancel();
  }, [coordinator, overlayOpen]);
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
    const revision = ++latestRevision;
    const operation = tail.then(async () => {
      if (revision !== latestRevision || sizesEqual(lastApplied, size)) return;
      await bridge.setBottomBarSize(size);
      // Record every completed native mutation, even if a newer request arrived
      // while this write was in flight. Otherwise the queue can believe the
      // host is still at the prior size and incorrectly skip restoring the
      // renderer's latest detent.
      lastApplied = size;
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

type ChatOverlaySizeRpcMethod =
  | "desktopSetBottomBarSize"
  | "desktopSetBottomBarInteractiveSize";
type ChatOverlaySizeIpcChannel =
  | "desktop:setBottomBarSize"
  | "desktop:setBottomBarInteractiveSize";

function useChatOverlayNativeMaterialSize(
  onFailure: (error: unknown) => void,
  rpcMethod: ChatOverlaySizeRpcMethod,
  ipcChannel: ChatOverlaySizeIpcChannel,
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
            rpcMethod,
            ipcChannel,
            params: size,
          });
        },
        onFailure: (error) => onFailureRef.current(error),
      }),
    [ipcChannel, rpcMethod],
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

/** Applies measured material size without duplicating native display geometry. */
export function useChatOverlayWindowSize(
  onFailure: (error: unknown) => void,
): (size: ChatOverlayMaterialSize) => void {
  return useChatOverlayNativeMaterialSize(
    onFailure,
    "desktopSetBottomBarSize",
    "desktop:setBottomBarSize",
  );
}

/** Publishes the visible material separately from the stable window envelope. */
export function useChatOverlayWindowInteractiveSize(
  onFailure: (error: unknown) => void,
): (size: ChatOverlayMaterialSize) => void {
  return useChatOverlayNativeMaterialSize(
    onFailure,
    "desktopSetBottomBarInteractiveSize",
    "desktop:setBottomBarInteractiveSize",
  );
}
