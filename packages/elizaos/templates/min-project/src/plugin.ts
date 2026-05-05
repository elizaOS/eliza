import type { Plugin } from "@elizaos/core";

const APP_NAME = "__APP_NAME__";

const plugin: Plugin = {
  name: APP_NAME,
  description: `Runtime plugin for the ${APP_NAME} app.`,
};

export default plugin;
export { plugin };
