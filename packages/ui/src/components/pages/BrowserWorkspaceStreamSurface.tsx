/**
 * Interactive renderer for a browser session that runs outside the app realm.
 * It paints Chromium screencast frames without embedding the target site and
 * relays explicit pointer, wheel, keyboard, paste, and viewport events.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type BrowserWorkspaceFrame,
  type BrowserWorkspaceInput,
  client,
} from "../../api";

interface BrowserWorkspaceStreamSurfaceProps {
  tabId: string;
  title: string;
}

function pointerButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

export function BrowserWorkspaceStreamSurface({
  tabId,
  title,
}: BrowserWorkspaceStreamSurfaceProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<BrowserWorkspaceFrame | null>(null);
  const viewportRef = useRef<{ height: number; width: number } | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMoveRef = useRef<BrowserWorkspaceInput | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enqueueInput = useCallback(
    (input: BrowserWorkspaceInput) => {
      inputQueueRef.current = inputQueueRef.current
        .then(async () => {
          await client.sendBrowserWorkspaceInput(tabId, input);
        })
        .catch((inputError) => {
          // error-policy:J4 the remote page remains visible while the failed
          // input is surfaced as an explicit browser-control error.
          setError(
            inputError instanceof Error
              ? inputError.message
              : "Browser input relay failed.",
          );
        });
    },
    [tabId],
  );

  const pointInFrame = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const image = imageRef.current;
      const frame = frameRef.current;
      if (!image || !frame) return null;
      const bounds = image.getBoundingClientRect();
      const sourceRatio = frame.width / frame.height;
      const boundsRatio = bounds.width / bounds.height;
      const renderedWidth =
        boundsRatio > sourceRatio ? bounds.height * sourceRatio : bounds.width;
      const renderedHeight =
        boundsRatio > sourceRatio ? bounds.height : bounds.width / sourceRatio;
      const left = bounds.left + (bounds.width - renderedWidth) / 2;
      const top = bounds.top + (bounds.height - renderedHeight) / 2;
      if (
        clientX < left ||
        clientX > left + renderedWidth ||
        clientY < top ||
        clientY > top + renderedHeight
      ) {
        return null;
      }
      return {
        x: ((clientX - left) / renderedWidth) * frame.width,
        y: ((clientY - top) / renderedHeight) * frame.height,
      };
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let close: (() => Promise<void>) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let releaseReconnectWait: (() => void) | null = null;
    setConnected(false);
    setError(null);

    const waitBeforeReconnect = (delayMs: number): Promise<void> =>
      new Promise((resolve) => {
        releaseReconnectWait = resolve;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          releaseReconnectWait = null;
          resolve();
        }, delayMs);
      });
    const run = async (): Promise<void> => {
      let reconnectAttempt = 0;
      while (!disposed) {
        try {
          const subscription = await client.streamBrowserWorkspaceTabFrames(
            tabId,
            (frame) => {
              if (disposed) return;
              const viewport = viewportRef.current;
              if (
                viewport &&
                (Math.abs(frame.width - viewport.width) > 1 ||
                  Math.abs(frame.height - viewport.height) > 1)
              ) {
                return;
              }
              frameRef.current = frame;
              if (imageRef.current) {
                imageRef.current.src = `data:image/jpeg;base64,${frame.data}`;
              }
              reconnectAttempt = 0;
              setConnected(true);
              setError(null);
            },
          );
          if (disposed) {
            await subscription.close();
            return;
          }
          close = subscription.close;
          await subscription.done;
          close = null;
          if (disposed) return;
          setConnected(false);
        } catch (streamError) {
          // error-policy:J4 the last good frame remains visible while the
          // reconnect loop presents a distinct connection error state.
          close = null;
          if (disposed) return;
          setConnected(false);
          setError(
            streamError instanceof Error
              ? streamError.message
              : "Browser frame stream failed.",
          );
        }
        reconnectAttempt += 1;
        await waitBeforeReconnect(
          Math.min(5_000, 250 * 2 ** Math.min(reconnectAttempt, 4)),
        );
      }
    };
    void run();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      releaseReconnectWait?.();
      reconnectTimer = null;
      releaseReconnectWait = null;
      if (moveFrameRef.current !== null) {
        cancelAnimationFrame(moveFrameRef.current);
        moveFrameRef.current = null;
      }
      if (close) {
        void close();
      }
    };
  }, [tabId]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let resizeFrame: number | null = null;
    const resize = (width: number, height: number): void => {
      const roundedWidth = Math.round(width);
      const roundedHeight = Math.round(height);
      if (roundedWidth < 1 || roundedHeight < 1) return;
      viewportRef.current = {
        height: roundedHeight,
        width: roundedWidth,
      };
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        void client
          .resizeBrowserWorkspaceTab(tabId, {
            width: roundedWidth,
            height: roundedHeight,
            deviceScaleFactor: 1,
          })
          .catch((resizeError) => {
            // error-policy:J4 viewport failure is visible and distinct from a
            // successfully resized browser surface.
            setError(
              resizeError instanceof Error
                ? resizeError.message
                : "Browser viewport resize failed.",
            );
          });
      });
    };
    const resizeFromBounds = (): void => {
      const bounds = root.getBoundingClientRect();
      resize(bounds.width, bounds.height);
    };
    resizeFromBounds();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resizeFromBounds);
      return () => {
        window.removeEventListener("resize", resizeFromBounds);
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        viewportRef.current = null;
      };
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      viewportRef.current = null;
    };
  }, [tabId]);

  const sendPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const point = pointInFrame(event.clientX, event.clientY);
      if (!point) return;
      pendingMoveRef.current = {
        type: "pointer",
        phase: "move",
        ...point,
      };
      if (moveFrameRef.current !== null) return;
      moveFrameRef.current = requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const input = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (input) enqueueInput(input);
      });
    },
    [enqueueInput, pointInFrame],
  );

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 h-full w-full overflow-hidden border-0 bg-bg p-0 text-left outline-none"
      role="application"
      tabIndex={-1}
      aria-label={title}
      title={title}
      data-testid="browser-workspace-stream-surface"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const point = pointInFrame(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        enqueueInput({
          type: "pointer",
          phase: "down",
          button: pointerButton(event.button),
          ...point,
        });
      }}
      onPointerMove={sendPointerMove}
      onPointerUp={(event) => {
        const point = pointInFrame(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        enqueueInput({
          type: "pointer",
          phase: "up",
          button: pointerButton(event.button),
          ...point,
        });
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onWheel={(event) => {
        const point = pointInFrame(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        enqueueInput({
          type: "wheel",
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ...point,
        });
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        enqueueInput({
          type: "key",
          phase: "down",
          key: event.key,
          ...(event.key.length === 1 ? { text: event.key } : {}),
        });
      }}
      onKeyUp={(event) => {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        enqueueInput({ type: "key", phase: "up", key: event.key });
      }}
      onCompositionEnd={(event) => {
        const text = event.data;
        if (!text) return;
        event.preventDefault();
        enqueueInput({ type: "text", text });
      }}
      onPaste={(event) => {
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        enqueueInput({ type: "text", text });
      }}
    >
      <img
        ref={imageRef}
        alt=""
        aria-hidden
        draggable={false}
        className="h-full w-full select-none object-contain"
      />
      {!connected ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-bg text-sm text-muted"
          role={error ? "alert" : "status"}
        >
          {error ?? "Connecting to browser session…"}
        </div>
      ) : error ? (
        <div
          className="absolute left-1/2 top-6 -translate-x-1/2 rounded-sm border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
