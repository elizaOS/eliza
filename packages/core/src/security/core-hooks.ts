/** Kernel incoming-message sanitization. Assistant response-risk policy is
 * registered by the separately composed assistant plugin. */

import type { Plugin } from "../types/plugin";
import { registerCoreIncomingMessageSecurityHook } from "./incoming-message-security";

export const CORE_SECURITY_HOOKS_PLUGIN_NAME = "core-security-hooks";

/** Register incoming-message security through ordinary plugin ownership. */
export function createCoreSecurityHooksPlugin(): Plugin {
	return {
		name: CORE_SECURITY_HOOKS_PLUGIN_NAME,
		description: "Always-on incoming-message external-content hardening.",
		init: (_config, runtime) => {
			registerCoreIncomingMessageSecurityHook(runtime);
		},
	};
}
