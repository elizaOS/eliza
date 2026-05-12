import type { JSDOM } from "jsdom";
import type {
  BrowserWorkspaceDomElementSummary,
  BrowserWorkspaceMode,
  BrowserWorkspaceRuntimeState,
  WebBrowserWorkspaceTabState,
} from "./browser-workspace-types.js";

export const webWorkspaceState: {
  nextId: number;
  tabs: WebBrowserWorkspaceTabState[];
} = {
  nextId: 1,
  tabs: [],
};

export const browserWorkspaceElementRefs = new Map<
  string,
  Map<string, string>
>();
export const browserWorkspaceRuntimeState = new Map<
  string,
  BrowserWorkspaceRuntimeState
>();
export let browserWorkspaceClipboardText = "";

export function setBrowserWorkspaceClipboardText(value: string): void {
  browserWorkspaceClipboardText = value;
}

/**
 * Simple async mutex to serialise mutations to webWorkspaceState.
 * Prevents concurrent requests from corrupting tab state or history.
 */
let webStateLock: Promise<void> = Promise.resolve();
export function withWebStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = webStateLock.then(fn, fn);
  webStateLock = next.then(
    () => {},
    () => {},
  );
  return next;
}

export function resetWebStateLock(): void {
  webStateLock = Promise.resolve();
}

export function createBrowserWorkspaceRuntimeState(): BrowserWorkspaceRuntimeState {
  return {
    consoleEntries: [],
    currentFrame: null,
    dialog: null,
    errors: [],
    frameDoms: new Map<string, JSDOM>(),
    highlightedSelector: null,
    lastScreenshotData: null,
    lastSnapshot: null,
    mouse: { buttons: [], x: 0, y: 0 },
    networkHar: { active: false, entries: [], startedAt: null },
    networkNextRequestId: 1,
    networkRequests: [],
    networkRoutes: [],
    settings: {
      credentials: null,
      device: null,
      geo: null,
      headers: {},
      media: null,
      offline: false,
      viewport: null,
    },
    trace: { active: false, entries: [] },
    profiler: { active: false, entries: [] },
  };
}

function getBrowserWorkspaceRuntimeStateKey(
  mode: BrowserWorkspaceMode,
  tabId: string,
): string {
  return `${mode}:${tabId}`;
}

export function getBrowserWorkspaceRuntimeState(
  mode: BrowserWorkspaceMode,
  tabId: string,
): BrowserWorkspaceRuntimeState {
  const key = getBrowserWorkspaceRuntimeStateKey(mode, tabId);
  let state = browserWorkspaceRuntimeState.get(key);
  if (!state) {
    state = createBrowserWorkspaceRuntimeState();
    browserWorkspaceRuntimeState.set(key, state);
  }
  return state;
}

export function clearBrowserWorkspaceRuntimeState(
  mode: BrowserWorkspaceMode,
  tabId: string,
): void {
  browserWorkspaceRuntimeState.delete(
    getBrowserWorkspaceRuntimeStateKey(mode, tabId),
  );
}

export function resetBrowserWorkspaceRuntimeNavigationState(
  state: BrowserWorkspaceRuntimeState,
): void {
  state.currentFrame = null;
  state.dialog = null;
  state.frameDoms.clear();
  state.highlightedSelector = null;
}

function getBrowserWorkspaceElementRefStateKey(
  mode: BrowserWorkspaceMode,
  tabId: string,
): string {
  return `${mode}:${tabId}`;
}

export function clearBrowserWorkspaceElementRefs(
  mode: BrowserWorkspaceMode,
  tabId: string,
): void {
  browserWorkspaceElementRefs.delete(
    getBrowserWorkspaceElementRefStateKey(mode, tabId),
  );
}

export function registerBrowserWorkspaceElementRefs(
  mode: BrowserWorkspaceMode,
  tabId: string,
  elements: BrowserWorkspaceDomElementSummary[],
): BrowserWorkspaceDomElementSummary[] {
  if (elements.length === 0) {
    clearBrowserWorkspaceElementRefs(mode, tabId);
    return [];
  }

  const refs = new Map<string, string>();
  const augmented = elements.map((element, index) => {
    const ref = `@e${index + 1}`;
    refs.set(ref, element.selector);
    return { ...element, ref };
  });
  browserWorkspaceElementRefs.set(
    getBrowserWorkspaceElementRefStateKey(mode, tabId),
    refs,
  );
  return augmented;
}

export function resolveBrowserWorkspaceElementRef(
  mode: BrowserWorkspaceMode,
  tabId: string,
  ref: string,
): string | null {
  return (
    browserWorkspaceElementRefs
      .get(getBrowserWorkspaceElementRefStateKey(mode, tabId))
      ?.get(ref.trim()) ?? null
  );
}

export function appendBrowserWorkspaceTraceEntry(
  state: BrowserWorkspaceRuntimeState,
  entry: Record<string, unknown>,
): void {
  if (!state.trace.active) {
    return;
  }
  state.trace.entries.push({
    ...entry,
    timestamp: getBrowserWorkspaceTimestamp(),
  });
}

export function appendBrowserWorkspaceProfilerEntry(
  state: BrowserWorkspaceRuntimeState,
  entry: Record<string, unknown>,
): void {
  if (!state.profiler.active) {
    return;
  }
  state.profiler.entries.push({
    ...entry,
    timestamp: getBrowserWorkspaceTimestamp(),
  });
}

export function getBrowserWorkspaceTimestamp(): string {
  return new Date().toISOString();
}

/** @internal - test-only reset */
export async function __resetBrowserWorkspaceStateForTests(): Promise<void> {
  await withWebStateLock(async () => {
    webWorkspaceState.nextId = 1;
    webWorkspaceState.tabs = [];
    browserWorkspaceElementRefs.clear();
    browserWorkspaceRuntimeState.clear();
    browserWorkspaceClipboardText = "";
  });
  resetWebStateLock();
}
