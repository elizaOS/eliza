/**
 * @elizaos/plugin-sql 1.7.1 publishes broken root export typings: the package
 * points TypeScript at a missing `types/index.d.ts`. The frontend typecheck
 * reaches the db schema through shared imports, so keep this shim narrow.
 */
declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";

  const plugin: Plugin;
  export default plugin;
}
