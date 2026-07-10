/**
 * Type-only shim for the agent root bootstrap imported by Android bridge code.
 *
 * Runtime code loads the real package dynamically; this stand-in exists only so
 * the bridge package can typecheck without a built agent distribution.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
	AndroidCoreRouteDeps,
	AndroidDispatchRoute,
} from "../android/dispatch.ts";

export function startEliza(_options: {
	serverOnly: true;
	localAgentMode: true;
}): Promise<IAgentRuntime | undefined> {
	throw new Error("Type shim only");
}

export const dispatchRoute: AndroidDispatchRoute = () => {
	throw new Error("Type shim only");
};

export const configFileExists: AndroidCoreRouteDeps["configFileExists"] =
	() => {
		throw new Error("Type shim only");
	};

export const loadElizaConfig: AndroidCoreRouteDeps["loadElizaConfig"] = () => {
	throw new Error("Type shim only");
};

export const saveElizaConfig: AndroidCoreRouteDeps["saveElizaConfig"] = () => {
	throw new Error("Type shim only");
};

export const hasPersistedFirstRunState: AndroidCoreRouteDeps["hasPersistedFirstRunState"] =
	() => {
		throw new Error("Type shim only");
	};
