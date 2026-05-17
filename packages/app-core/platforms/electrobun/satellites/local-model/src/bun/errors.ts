import type {
	ModelSatelliteError,
	ModelSatelliteErrorCode,
} from "./protocol.ts";

export class ModelSatelliteException extends Error {
	readonly code: ModelSatelliteErrorCode;
	readonly modelId?: string;
	readonly path?: string;
	readonly status?: number;
	readonly details?: unknown;

	constructor(error: ModelSatelliteError) {
		super(error.message);
		this.name = "ModelSatelliteException";
		this.code = error.code;
		this.modelId = error.modelId;
		this.path = error.path;
		this.status = error.status;
		this.details = error.details;
	}

	toJSON(): ModelSatelliteError {
		return createModelError({
			code: this.code,
			message: this.message,
			modelId: this.modelId,
			path: this.path,
			status: this.status,
			details: this.details,
		});
	}
}

export function createModelError(error: ModelSatelliteError): ModelSatelliteError {
	const payload: ModelSatelliteError = {
		code: error.code,
		message: error.message,
	};
	if (error.modelId !== undefined) payload.modelId = error.modelId;
	if (error.path !== undefined) payload.path = error.path;
	if (error.status !== undefined) payload.status = error.status;
	if (error.details !== undefined) payload.details = error.details;
	return payload;
}

export function throwModelError(error: ModelSatelliteError): never {
	throw new ModelSatelliteException(createModelError(error));
}

export function isModelSatelliteError(
	value: unknown,
): value is ModelSatelliteError {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		typeof (value as { code?: unknown }).code === "string" &&
		"message" in value &&
		typeof (value as { message?: unknown }).message === "string"
	);
}

export function serializeError(error: unknown): ModelSatelliteError {
	if (error instanceof ModelSatelliteException) return error.toJSON();
	if (isModelSatelliteError(error)) return createModelError(error);
	if (error instanceof Error) {
		return createModelError({
			code: "MODEL_UNKNOWN",
			message: error.message,
			details: error.stack,
		});
	}
	return createModelError({
		code: "MODEL_UNKNOWN",
		message: "Model Satellite request failed.",
		details: error,
	});
}
