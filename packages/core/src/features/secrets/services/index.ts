/**
 * Services module exports
 */

export type { PluginWithSecrets } from "./plugin-activator.ts";
export {
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	PluginActivatorService,
} from "./plugin-activator.ts";
export { SECRETS_SERVICE_TYPE, SecretsService } from "./secrets.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { PLUGIN_ACTIVATOR_SERVICE_TYPE as _bs_1_PLUGIN_ACTIVATOR_SERVICE_TYPE, PluginActivatorService as _bs_2_PluginActivatorService } from "./plugin-activator.ts";
import { SECRETS_SERVICE_TYPE as _bs_3_SECRETS_SERVICE_TYPE, SecretsService as _bs_4_SecretsService } from "./secrets.ts";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_SECRETS_SERVICES_INDEX__ = [_bs_1_PLUGIN_ACTIVATOR_SERVICE_TYPE, _bs_2_PluginActivatorService, _bs_3_SECRETS_SERVICE_TYPE, _bs_4_SecretsService];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_FEATURES_SECRETS_SERVICES_INDEX__ = __bundle_safety_FEATURES_SECRETS_SERVICES_INDEX__;
