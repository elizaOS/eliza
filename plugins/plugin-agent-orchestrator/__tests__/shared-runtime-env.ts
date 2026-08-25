/** Exposes the shared runtime helpers used by orchestrator tests without loading the generated-data barrel. */
export * from "../../../packages/shared/src/contracts/coding-agent-capabilities.js";
export {
  isAndroidMobile,
  resolvePlatform,
} from "../../../packages/shared/src/runtime-env.js";
export { readAliasedEnv } from "../../../packages/shared/src/utils/env.js";
