import type { ComputerError, ComputerErrorCode } from "./protocol.ts";

export class ComputerSatelliteException extends Error {
	readonly code: ComputerErrorCode;
	readonly details?: unknown;

	constructor(error: ComputerError) {
		super(error.message);
		this.name = "ComputerSatelliteException";
		this.code = error.code;
		this.details = error.details;
	}
}

export function throwComputerError(error: ComputerError): never {
	throw new ComputerSatelliteException(error);
}

export function serializeComputerError(error: unknown): ComputerError {
	if (error instanceof ComputerSatelliteException) {
		return {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	if (error instanceof Error) {
		return {
			code: "COMPUTER_REQUEST_FAILED",
			message: error.message,
		};
	}
	return {
		code: "COMPUTER_UNKNOWN",
		message: String(error),
	};
}
