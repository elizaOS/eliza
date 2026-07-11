/**
 * Runtime plugin entrypoint for the scaffolded minimal app project.
 */

import type { Plugin } from "@elizaos/core";

const APP_NAME = "arklib-setup";

const plugin: Plugin = {
  name: APP_NAME,
  description: `Runtime plugin for the ${APP_NAME} app.`,
};

export default plugin;
export { plugin };
