import type { OverlayApp } from "@elizaos/app-core";
import { registerOverlayApp } from "@elizaos/app-core";
import { ModelTesterAppView } from "./ModelTesterAppView.js";

export const MODEL_TESTER_APP_NAME = "@elizaos/app-model-tester";

export const modelTesterApp: OverlayApp = {
  name: MODEL_TESTER_APP_NAME,
  displayName: "Model Tester",
  description:
    "Run end-to-end probes for Eliza-1 text, voice, audio, and vision models",
  category: "system",
  icon: null,
  Component: ModelTesterAppView,
};

registerOverlayApp(modelTesterApp);
