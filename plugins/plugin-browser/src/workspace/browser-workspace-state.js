export const webWorkspaceState = {
    nextId: 1,
    tabs: [],
};
export const browserWorkspaceElementRefs = new Map();
export const browserWorkspaceRuntimeState = new Map();
export let browserWorkspaceClipboardText = "";
export function setBrowserWorkspaceClipboardText(value) {
    browserWorkspaceClipboardText = value;
}
/**
 * Simple async mutex to serialise mutations to webWorkspaceState.
 * Prevents concurrent requests from corrupting tab state or history.
 */
let webStateLock = Promise.resolve();
export function withWebStateLock(fn) {
    const next = webStateLock.then(fn, fn);
    webStateLock = next.then(() => { }, () => { });
    return next;
}
export function resetWebStateLock() {
    webStateLock = Promise.resolve();
}
export function createBrowserWorkspaceRuntimeState() {
    return {
        consoleEntries: [],
        currentFrame: null,
        dialog: null,
        errors: [],
        frameDoms: new Map(),
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
function getBrowserWorkspaceRuntimeStateKey(mode, tabId) {
    return `${mode}:${tabId}`;
}
export function getBrowserWorkspaceRuntimeState(mode, tabId) {
    const key = getBrowserWorkspaceRuntimeStateKey(mode, tabId);
    let state = browserWorkspaceRuntimeState.get(key);
    if (!state) {
        state = createBrowserWorkspaceRuntimeState();
        browserWorkspaceRuntimeState.set(key, state);
    }
    return state;
}
export function clearBrowserWorkspaceRuntimeState(mode, tabId) {
    browserWorkspaceRuntimeState.delete(getBrowserWorkspaceRuntimeStateKey(mode, tabId));
}
export function resetBrowserWorkspaceRuntimeNavigationState(state) {
    state.currentFrame = null;
    state.dialog = null;
    state.frameDoms.clear();
    state.highlightedSelector = null;
}
function getBrowserWorkspaceElementRefStateKey(mode, tabId) {
    return `${mode}:${tabId}`;
}
export function clearBrowserWorkspaceElementRefs(mode, tabId) {
    browserWorkspaceElementRefs.delete(getBrowserWorkspaceElementRefStateKey(mode, tabId));
}
export function registerBrowserWorkspaceElementRefs(mode, tabId, elements) {
    if (elements.length === 0) {
        clearBrowserWorkspaceElementRefs(mode, tabId);
        return [];
    }
    const refs = new Map();
    const augmented = elements.map((element, index) => {
        const ref = `@e${index + 1}`;
        refs.set(ref, element.selector);
        return { ...element, ref };
    });
    browserWorkspaceElementRefs.set(getBrowserWorkspaceElementRefStateKey(mode, tabId), refs);
    return augmented;
}
export function resolveBrowserWorkspaceElementRef(mode, tabId, ref) {
    return (browserWorkspaceElementRefs
        .get(getBrowserWorkspaceElementRefStateKey(mode, tabId))
        ?.get(ref.trim()) ?? null);
}
export function appendBrowserWorkspaceTraceEntry(state, entry) {
    if (!state.trace.active) {
        return;
    }
    state.trace.entries.push({
        ...entry,
        timestamp: getBrowserWorkspaceTimestamp(),
    });
}
export function appendBrowserWorkspaceProfilerEntry(state, entry) {
    if (!state.profiler.active) {
        return;
    }
    state.profiler.entries.push({
        ...entry,
        timestamp: getBrowserWorkspaceTimestamp(),
    });
}
export function getBrowserWorkspaceTimestamp() {
    return new Date().toISOString();
}
/** @internal - test-only reset */
export async function __resetBrowserWorkspaceStateForTests() {
    await withWebStateLock(async () => {
        webWorkspaceState.nextId = 1;
        webWorkspaceState.tabs = [];
        browserWorkspaceElementRefs.clear();
        browserWorkspaceRuntimeState.clear();
        browserWorkspaceClipboardText = "";
    });
    resetWebStateLock();
}
