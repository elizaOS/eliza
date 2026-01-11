/**
 * Node.js entry point for @elizaos/plugin-todo
 */
import { routes } from "./apis";
import todoPlugin from "./index";

// Add routes to the plugin for Node.js builds
const nodePlugin = {
  ...todoPlugin,
  routes,
};

// Override default export with routes-enabled version
export { nodePlugin as default };
