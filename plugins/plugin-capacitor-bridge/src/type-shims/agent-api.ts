/**
 * Type-only shim for agent API imports used by the Capacitor bridge package.
 *
 * The real `dispatchRoute` implementation is loaded dynamically at runtime;
 * this file lets package-local typechecking avoid depending on built agent
 * output.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export function dispatchRoute(
	_req: IncomingMessage,
	_res: ServerResponse,
): void | Promise<void> {
	throw new Error("Type shim only");
}
