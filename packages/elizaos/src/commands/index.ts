/**
 * Command barrel for the CLI entrypoint and library consumers that import
 * individual elizaOS command functions.
 */

export {
  capabilityRouterConnect,
  runCapabilityRouterConnect,
} from "./capability-router.js";
export { create } from "./create.js";
export {
  DEPLOY_COMMAND_DESCRIPTION,
  DEPLOY_DRY_RUN_DESCRIPTION,
  deploy,
  runDeploy,
} from "./deploy.js";
export { info } from "./info.js";
export { migrateAgent } from "./migrate-agent.js";
export { registerPluginsCommand, submitPluginToRegistry } from "./plugins.js";
export { upgrade } from "./upgrade.js";
export { version } from "./version.js";
