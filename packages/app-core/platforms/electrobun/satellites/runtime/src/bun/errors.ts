import type { ApiBridgeError } from "./protocol.ts";

export function createApiBridgeError(input: ApiBridgeError): ApiBridgeError {
	return {
		code: input.code,
		message: input.message,
		...(input.method === undefined ? {} : { method: input.method }),
		...(input.path === undefined ? {} : { path: input.path }),
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.details === undefined ? {} : { details: input.details }),
	};
}

export function isApiBridgeError(value: unknown): value is ApiBridgeError {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.code === "string" &&
		typeof record.message === "string" &&
		[
			"RUNTIME_NOT_RUNNING",
			"API_BASE_MISSING",
			"ROUTE_UNAVAILABLE",
			"REQUEST_FAILED",
			"DECODE_FAILED",
			"CAPABILITY_UNAVAILABLE",
			"UNKNOWN",
		].includes(record.code)
	);
}

export function serializeError(error: unknown): ApiBridgeError {
	if (isApiBridgeError(error)) return createApiBridgeError(error);
	if (error instanceof Error) {
		return createApiBridgeError({
			code: "UNKNOWN",
			message: error.message.length > 0 ? error.message : error.name,
		});
	}
	return createApiBridgeError({
		code: "UNKNOWN",
		message: "Unknown Runtime Satellite failure",
		details: typeof error === "string" ? error : undefined,
	});
}
