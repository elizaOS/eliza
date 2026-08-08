/**
 * Resolves the API listener used by app-control's server-side loopback calls.
 * Desktop development separates the public Vite port from the API listener,
 * while CLI and packaged single-process hosts expose both on one port.
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import {
	firstWinningEnvString,
	resolveDesktopApiPort,
} from "@elizaos/shared/runtime-env";

type RuntimeEnv = Record<string, string | undefined>;

/** Return the listener that the runtime itself bound, never the Vite UI proxy. */
export function resolveAppControlLoopbackPort(
	env: RuntimeEnv = process.env,
): number {
	return firstWinningEnvString(env, ["ELIZA_API_PORT"])
		? resolveDesktopApiPort(env)
		: resolveServerOnlyPort(env);
}

export function getAppControlApiBase(env: RuntimeEnv = process.env): string {
	return `http://127.0.0.1:${resolveAppControlLoopbackPort(env)}`;
}
