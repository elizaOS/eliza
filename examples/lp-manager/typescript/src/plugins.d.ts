/**
 * Type declarations for workspace plugins
 * These declarations allow TypeScript to resolve the module imports
 * during type checking, while Bun handles the actual runtime resolution.
 */

declare module "@elizaos/plugin-lp-manager" {
  import type { Plugin } from "@elizaos/core";
  const plugin: Plugin;
  export default plugin;
}

declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";
  const plugin: Plugin;
  export default plugin;
}
