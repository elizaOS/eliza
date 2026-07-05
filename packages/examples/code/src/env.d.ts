// Type declarations for modules without types

declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";
  export const plugin: Plugin;
}

declare module "@elizaos/plugin-goals" {
  import type { Plugin } from "@elizaos/core";

  const plugin: Plugin;
  export default plugin;
}
