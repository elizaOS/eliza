import type { Plugin } from "@elizaos/core";
import {
  closeAllViewsAction,
  closeViewAction,
  showViewAction,
  viewsAction,
} from "./actions/views.js";
import {
  viewContextPlanningEvaluator,
  viewContinuationField,
} from "./evaluators/view-context-planning.js";
import { currentViewProvider } from "./providers/current-view.js";
import {
  applyCurrentViewComposeHook,
  CURRENT_VIEW_HOOK_ID,
} from "./runtime/current-view-hook.js";

export const appControlPlugin: Plugin = {
  name: "app-control",
  description:
    "Authorized app-view navigation and management. Navigation receipts do not prove record operations.",
  actions: [viewsAction, showViewAction, closeViewAction, closeAllViewsAction],
  responseHandlerEvaluators: [viewContextPlanningEvaluator],
  responseHandlerFieldEvaluators: [viewContinuationField],
  providers: [currentViewProvider],
  async init(_config, runtime) {
    runtime.registerPipelineHook({
      id: CURRENT_VIEW_HOOK_ID,
      phase: "compose_state_providers",
      handler: (_rt, ctx) => {
        if (ctx.phase === "compose_state_providers")
          applyCurrentViewComposeHook(ctx);
      },
    });
  },
};
export default appControlPlugin;
