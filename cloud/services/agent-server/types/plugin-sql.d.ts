/** @elizaos/plugin-sql root export resolves to JS without typings under `exports`; default is the SQL plugin. */
declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";

  const plugin: Plugin;
  export default plugin;
}
