/**
 * Re-exports the browser-tabs renderer registry (preload script + impl setter)
 * so the desktop host can install its renderer implementation.
 */
export {
  BROWSER_TAB_PRELOAD_SCRIPT,
  type BrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "@elizaos/shared";
