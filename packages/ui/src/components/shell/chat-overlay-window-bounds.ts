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

export const CHAT_OVERLAY_RESTING_WINDOW_WIDTH = 64;
export const CHAT_OVERLAY_RESTING_WINDOW_HEIGHT = 44;
export const CHAT_OVERLAY_EXPANDED_WINDOW_WIDTH = 600;
export const CHAT_OVERLAY_EXPANDED_WINDOW_HEIGHT = 820;

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
