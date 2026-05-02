/** @elizaos/plugin-sql root export resolves to JS without usable package-export typings. */
declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";

  const plugin: Plugin;
  export default plugin;
}
