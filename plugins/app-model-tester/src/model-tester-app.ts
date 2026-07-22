/**
 * Registers the Model Tester with the app-shell and overlay-app registries at
 * import time: the overlay app (`@elizaos/app-model-tester`) and the
 * `/model-tester` shell page, both lazy-loading `ModelTesterAppView`. Importing
 * this module for its side effects is intentional; do not tree-shake it.
 */

import { dispatchNavigateViewEvent } from "@elizaos/shared/events";
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
  // Return to the apps launcher through the shell's navigate-view event. A view
  // mounted under a surface-realm scope may not drive raw history.pushState —
  // the navigation guard (#15247) denies it without the `navigate` grant — so
  // it asks the shell, which listens for this event and owns the privileged
  // route change.
  dispatchNavigateViewEvent({ viewPath: "/apps" });
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
