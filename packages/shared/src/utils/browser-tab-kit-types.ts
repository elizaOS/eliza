/**
 * Typed contract for the in-tab kit installed by BROWSER_TAB_PRELOAD_SCRIPT.
 *
 * The kit lives at `window.__elizaTabKit` inside every <electrobun-webview>
 * tab and provides:
 *   - a visual cursor overlay the user sees moving as the agent works,
 *   - faithful pointer-event sequences (vs the bare `element.click()` of the
 *     legacy command path),
 *   - keyboard-accurate typing that triggers React controlled-input change
 *     detection.
 *
 * The host (running in the main webview) calls these via short
 * `tag.executeJavascript(...)` snippets that reference `window.__elizaTabKit.*`.
 * The original `__elizaTabExec(requestId, script)` channel is unchanged — the
 * kit is additive.
 *
 * Synthetic events have `isTrusted === false` (not forge-able from script).
 * That's acceptable for React-driven sites and most Web3 UIs; sites that
 * specifically gate on `isTrusted` (rare) cannot be driven this way and need
 * the real CDP path (deferred future work).
 */

export interface BrowserTabKitCursorPoint {
  x: number;
  y: number;
}

export interface BrowserTabKitMoveOptions {
  /** Animation duration in ms; defaults to 220. */
  durationMs?: number;
}

export interface BrowserTabKitDispatchOptions {
  /** Center of the click in viewport CSS pixels. Defaults to element center. */
  x?: number;
  y?: number;
  /** Mouse button: 0 = primary, 1 = middle, 2 = secondary. Default 0. */
  button?: 0 | 1 | 2;
  /** True for double-click semantics. */
  doubleClick?: boolean;
}

export interface BrowserTabKitTypeOptions {
  /** Per-character delay in ms (uniform). Defaults to 18. */
  perCharDelayMs?: number;
  /** True to clear the existing value first. */
  replace?: boolean;
}

/**
 * Fully-formed RPC surface attached to `window.__elizaTabKit` inside every
 * agent-driven tab. Methods are async (returning Promise) when they involve
 * animation or fetch; sync otherwise.
 */
export interface BrowserTabKit {
  cursor: {
    moveTo: (
      target: BrowserTabKitCursorPoint,
      options?: BrowserTabKitMoveOptions,
    ) => Promise<void>;
    click: (target: BrowserTabKitCursorPoint) => Promise<void>;
    highlight: (element: Element, durationMs?: number) => void;
    show: () => void;
    hide: () => void;
  };
  dispatchPointerSequence: (
    target: Element,
    options?: BrowserTabKitDispatchOptions,
  ) => Promise<void>;
  typeRealistic: (
    target: Element,
    text: string,
    options?: BrowserTabKitTypeOptions,
  ) => Promise<void>;
  /**
   * Populate an `<input type=file>` from a URL or data: URI by fetching the
   * bytes, wrapping them in a File, and assigning via DataTransfer. Real
   * browser file inputs cannot be set from script otherwise — security
   * sandbox blocks direct .files assignment of arbitrary paths. DataTransfer
   * is the standard workaround that fires the file's `change` event.
   */
  setFileInput: (
    target: HTMLInputElement,
    url: string,
    options?: { fileName?: string; mimeType?: string },
  ) => Promise<{ name: string; size: number; type: string }>;
}

declare global {
  interface Window {
    __elizaTabKit?: BrowserTabKit;
  }
}
