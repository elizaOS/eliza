/**
 * Type-only shim for agent API imports used by the Capacitor bridge package.
 *
 * The real `dispatchRoute` implementation is loaded dynamically at runtime;
 * this file lets package-local typechecking avoid depending on built agent
 * output.
 */

import type { IAgentRuntime } from "@elizaos/core";

export function dispatchRoute(_args: {
	runtime: IAgentRuntime;
	method: string;
	path: string;
	headers: Record<string, string>;
	query: Record<string, string | string[]>;
	body: unknown;
	inProcess: true;
	isAuthorized: () => true;
}): Promise<
	| {
			status: number;
			headers?: Record<string, string>;
			body?: unknown;
	  }
	| null
	| undefined
> {
	throw new Error("Type shim only");
}
