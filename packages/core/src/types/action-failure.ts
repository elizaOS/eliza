/**
 * Defines the structural provenance attached to failed action results. The
 * planner carries this metadata through retry exhaustion so the final failure
 * boundary can distinguish capability, handler, and persistence failures
 * without parsing error prose.
 */
import { asObjectRecord } from "../utils/type-guards";

export type ActionFailureProvenance =
	| {
			kind: "missing_capability";
			boundary: "capability";
			code: string;
			retryable: false;
	  }
	| {
			kind: "handler_error";
			boundary: "handler";
			code: string;
			retryable: boolean;
	  }
	| {
			kind: "persistence_error";
			boundary: "persistence";
			code: string;
			retryable: boolean;
	  };

export type ActionFailureKind = ActionFailureProvenance["kind"];

/** Validate action-owned failure metadata before it enters a planner trace. */
export function normalizeActionFailureProvenance(
	value: unknown,
): ActionFailureProvenance {
	const record = asObjectRecord(value);
	if (!record) {
		throw new TypeError("ActionResult.failureProvenance must be an object.");
	}
	const code = typeof record.code === "string" ? record.code.trim() : "";
	if (!code) {
		throw new TypeError(
			"ActionResult.failureProvenance.code must be a non-empty string.",
		);
	}
	if (typeof record.retryable !== "boolean") {
		throw new TypeError(
			"ActionResult.failureProvenance.retryable must be a boolean.",
		);
	}

	switch (record.kind) {
		case "missing_capability":
			if (record.boundary !== "capability" || record.retryable !== false) {
				throw new TypeError(
					"missing_capability provenance must use the capability boundary and retryable:false.",
				);
			}
			return {
				kind: "missing_capability",
				boundary: "capability",
				code,
				retryable: false,
			};
		case "handler_error":
			if (record.boundary !== "handler") {
				throw new TypeError(
					"handler_error provenance must use the handler boundary.",
				);
			}
			return {
				kind: "handler_error",
				boundary: "handler",
				code,
				retryable: record.retryable,
			};
		case "persistence_error":
			if (record.boundary !== "persistence") {
				throw new TypeError(
					"persistence_error provenance must use the persistence boundary.",
				);
			}
			return {
				kind: "persistence_error",
				boundary: "persistence",
				code,
				retryable: record.retryable,
			};
		default:
			throw new TypeError(
				"ActionResult.failureProvenance.kind is not supported.",
			);
	}
}

/**
 * Read provenance from a thrown boundary error. Persistence adapters can attach
 * it directly or under ElizaError.context; malformed lookalikes fail closed and
 * are treated as ordinary handler errors by the settlement boundary.
 */
export function readActionFailureProvenance(
	error: unknown,
): ActionFailureProvenance | null {
	const record = asObjectRecord(error);
	if (!record) return null;
	const candidate =
		record.failureProvenance ??
		asObjectRecord(record.context)?.failureProvenance;
	if (candidate === undefined) return null;
	try {
		return normalizeActionFailureProvenance(candidate);
	} catch {
		// error-policy:J3 malformed thrown metadata is untrusted input. The
		// caller classifies the original exception as a handler error instead.
		return null;
	}
}
