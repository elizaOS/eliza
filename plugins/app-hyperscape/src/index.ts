import type { Plugin } from "@elizaos/core";

/**
 * `@elizaos/app-hyperscape` plugin entry point.
 *
 * Provides session resolvers for the Hyperscape game integration.
 * The route module (`./routes.ts`) handles live session resolution
 * by fetching data from the Hyperscape API.
 */
const hyperscapePlugin: Plugin = {
  name: "@elizaos/app-hyperscape",
  description:
    "Hyperscape game session resolvers — spectate-and-steer agent sessions with live data from the Hyperscape API.",
};

export default hyperscapePlugin;
export * from "./routes.js";
export * from "./ui.js";
