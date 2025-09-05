import type { Plugin } from "@elizaos/core";
import { typewriterActions } from "./actions/typewriter";
import { actionBenchFrontendRoutes } from "./routes/frontend";
import { testRoute } from "./routes/test-operations";

export const typewriterPlugin: Plugin = {
  name: "action-bench-typewriter",
  description:
    "Typewriter benchmark plugin providing 26 single-letter actions (A–Z) to test action selection and chaining.",
  actions: [...typewriterActions],
  routes: [...actionBenchFrontendRoutes, testRoute],
};

export default typewriterPlugin;


