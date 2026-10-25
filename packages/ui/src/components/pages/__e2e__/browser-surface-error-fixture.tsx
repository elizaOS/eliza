/**
 * Self-contained fixture for the native-surface error-card e2e: mounts the
 * REAL `BrowserWorkspaceView` with the surface hook harness-driven through
 * `location.hash` (#permanent = WebView multi-profile capability denial,
 * #transient = transport fault, empty = healthy). Only the `state`/`api`
 * barrels, `@capacitor/core`, and the surface hook module are stubbed (see
 * run-browser-surface-error-e2e.mjs); every rendered component is real. No app
 * server, no network. Paired with run-browser-surface-error-e2e.mjs.
 */

import { createRoot } from "react-dom/client";
import { BrowserWorkspaceView } from "../BrowserWorkspaceView";

const container = document.getElementById("root");
if (!container) throw new Error("fixture root missing");
createRoot(container).render(<BrowserWorkspaceView />);
