/**
 * Registers the Model Tester with the app-shell and overlay-app registries at
 * import time: the overlay app (`@elizaos/app-model-tester`) and the `/model-tester`
 * shell page, both lazy-loading `ModelTesterAppView`. In a terminal host (no DOM) it
 * also registers the unified spatial terminal view. Importing this module for its
 * side effects is intentional; do not tree-shake it.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import type { OverlayApp } from "@elizaos/ui/components/apps/overlay-app-api";
import { registerOverlayApp } from "@elizaos/ui/components/apps/overlay-app-registry";
import { createElement } from "react";

export const MODEL_TESTER_APP_NAME = "@elizaos/app-model-tester";

export const modelTesterApp: OverlayApp = {
  name: MODEL_TESTER_APP_NAME,
  displayName: "Model Tester",
  description:
    "Run end-to-end probes for Eliza-1 text, voice, audio, and vision models",
  category: "system",
  icon: null,
  loader: () =>
    import("./ModelTesterAppView.js").then((m) => ({
      default: m.ModelTesterAppView,
    })),
};

registerOverlayApp(modelTesterApp);

function exitToApps(): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", "/apps");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function translate(key: string, opts?: Record<string, unknown>): string {
  return typeof opts?.defaultValue === "string" ? opts.defaultValue : key;
}

registerAppShellPage({
  id: "model-tester",
  pluginId: MODEL_TESTER_APP_NAME,
  label: "Model Tester",
  icon: "TestTube2",
  path: "/model-tester",
  loader: () =>
    import("./ModelTesterAppView.js").then((module) => ({
      default: function ModelTesterShellPage() {
        return createElement(module.ModelTesterAppView, {
          exitToApps,
          uiTheme: "dark",
          t: translate,
        });
      },
    })),
});

// In a terminal host (the Node agent, no DOM), register the unified spatial
// view so the model tester renders inline in the terminal. Lazy + DOM-guarded
// so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerModelTesterTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
