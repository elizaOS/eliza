import type { FileSatelliteError, FileSatelliteErrorCode } from "./protocol.ts";

export class FileSatelliteException extends Error {
	readonly code: FileSatelliteErrorCode;
	readonly path?: string;
	readonly details?: unknown;

	constructor(input: FileSatelliteError) {
		super(input.message);
		this.name = "FileSatelliteException";
		this.code = input.code;
		this.path = input.path;
		this.details = input.details;
	}
}

export function createFileSatelliteError(
	input: FileSatelliteError,
): FileSatelliteError {
	return {
		code: input.code,
		message: input.message,
		...(input.path === undefined ? {} : { path: input.path }),
		...(input.details === undefined ? {} : { details: input.details }),
	};
}

export function throwFileSatelliteError(input: FileSatelliteError): never {
	throw new FileSatelliteException(createFileSatelliteError(input));
}

export function isFileSatelliteError(
	value: unknown,
): value is FileSatelliteError {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.code === "string" && typeof record.message === "string";
}

export function serializeFileError(error: unknown): FileSatelliteError {
	if (error instanceof FileSatelliteException) {
		return createFileSatelliteError({
			code: error.code,
			message: error.message,
			path: error.path,
			details: error.details,
		});
	}
	if (isFileSatelliteError(error)) return createFileSatelliteError(error);
	if (error instanceof Error) {
		return createFileSatelliteError({
			code: "FS_REQUEST_FAILED",
			message: error.message.length > 0 ? error.message : error.name,
		});
	}
	return createFileSatelliteError({
		code: "FS_UNKNOWN",
		message: "Unknown File Satellite failure",
		details: typeof error === "string" ? error : undefined,
	});
}
