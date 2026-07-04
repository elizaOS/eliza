/**
 * Android screen-capture bridge for agent-triggered, renderer-pulled frames.
 *
 * The agent runs outside Capacitor and cannot push to the renderer, so it
 * enqueues requests here. The renderer polls, captures via MediaProjection, and
 * posts PNG frames back to resolve matching promises.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

/** Service type used to resolve the bridge off the runtime. */
export const SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE =
  "vision-screen-capture-bridge";

/**
 * How long a `requestFrame` promise waits for the renderer to deliver a frame
 * before resolving `null`. The first capture has to wait on the Android
 * MediaProjection consent dialog, so this is generous.
 */
const REQUEST_FRAME_TIMEOUT_MS = 30_000;

/** A single enqueued capture request, drained by the GET poll. */
export interface ScreenCaptureRequest {
  requestId: string;
  createdAt: number;
  displayId?: number;
}

/** Result of a completed capture, returned to `requestFrame` callers. */
export interface ScreenCaptureFrame {
  pngBytes: Uint8Array;
  displayId: number;
  capturedAt: number;
}

interface PendingCapture {
  resolve: (frame: ScreenCaptureFrame | null) => void;
  displayId: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Renderer-pulled screen-capture bridge service.
 *
 * The agent calls `requestFrame()`; the renderer drains the queue via
 * `takeRequests()` and delivers frames via `submitFrame()`.
 */
export class ScreenCaptureBridgeService extends Service {
  static override serviceType: string = SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE;
  override capabilityDescription =
    "Renderer-pulled bridge for agent-triggered Android screen capture.";

  private readonly queue: ScreenCaptureRequest[] = [];
  private readonly pending = new Map<string, PendingCapture>();
  private readonly timeoutMs: number;

  constructor(
    runtime?: IAgentRuntime,
    timeoutMs: number = REQUEST_FRAME_TIMEOUT_MS,
  ) {
    super(runtime);
    this.timeoutMs = timeoutMs;
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<ScreenCaptureBridgeService> {
    return new ScreenCaptureBridgeService(runtime);
  }

  /**
   * Enqueue a capture request and wait for the renderer to deliver a frame.
   * Resolves `null` if no frame arrives within the timeout (never hangs).
   */
  requestFrame(displayId?: number): Promise<ScreenCaptureFrame | null> {
    const requestId = crypto.randomUUID();
    const request: ScreenCaptureRequest = {
      requestId,
      createdAt: Date.now(),
    };
    if (typeof displayId === "number") request.displayId = displayId;
    this.queue.push(request);

    return new Promise<ScreenCaptureFrame | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        logger.debug(
          `[ScreenCaptureBridgeService] capture request ${requestId} timed out after ${this.timeoutMs}ms`,
        );
        resolve(null);
      }, this.timeoutMs);
      // Do not keep the event loop alive solely for a pending capture.
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(requestId, {
        resolve,
        displayId: typeof displayId === "number" ? displayId : 0,
        timer,
      });
    });
  }

  /** Drain and return all queued requests (for the GET poll). */
  takeRequests(): ScreenCaptureRequest[] {
    return this.queue.splice(0, this.queue.length);
  }

  /**
   * Deliver a captured frame for a queued request. Returns false if the
   * requestId is unknown or already expired/resolved.
   */
  submitFrame(
    requestId: string,
    base64: string,
    _format: string,
    _width: number,
    _height: number,
  ): boolean {
    const pendingCapture = this.pending.get(requestId);
    if (!pendingCapture) return false;
    this.pending.delete(requestId);
    clearTimeout(pendingCapture.timer);
    const pngBytes = new Uint8Array(Buffer.from(base64, "base64"));
    pendingCapture.resolve({
      pngBytes,
      displayId: pendingCapture.displayId,
      capturedAt: Date.now(),
    });
    return true;
  }

  /**
   * Resolve a queued request as a skip/failure so the agent's pending promise
   * settles promptly (as `null`) instead of waiting the full timeout. The
   * renderer calls this when a capture throws or is unavailable. Returns false
   * for unknown/expired requestIds.
   */
  failFrame(requestId: string, reason: string): boolean {
    const pendingCapture = this.pending.get(requestId);
    if (!pendingCapture) return false;
    this.pending.delete(requestId);
    clearTimeout(pendingCapture.timer);
    logger.debug(
      `[ScreenCaptureBridgeService] capture request ${requestId} failed: ${reason}`,
    );
    pendingCapture.resolve(null);
    return true;
  }

  async stop(): Promise<void> {
    this.queue.length = 0;
    for (const [requestId, pendingCapture] of this.pending) {
      clearTimeout(pendingCapture.timer);
      pendingCapture.resolve(null);
      this.pending.delete(requestId);
    }
  }
}
