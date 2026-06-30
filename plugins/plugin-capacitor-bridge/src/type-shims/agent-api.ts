import type { IncomingMessage, ServerResponse } from "node:http";

export function dispatchRoute(
	_req: IncomingMessage,
	_res: ServerResponse,
): void | Promise<void> {
	throw new Error("Type shim only");
}
