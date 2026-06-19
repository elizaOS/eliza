const NON_PLAIN_CONSTRUCTORS = new Set([
	Array,
	Date,
	RegExp,
	Map,
	Set,
	WeakMap,
	WeakSet,
	Error,
	Promise,
	ArrayBuffer,
	DataView,
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
]);

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		return false;
	}

	// Check constructor - plain objects have Object or null prototype
	const proto = Object.getPrototypeOf(value);
	if (proto === null) {
		return true; // Object.create(null)
	}

	if (proto.constructor === Object) {
		return true;
	}

	// Explicitly exclude known built-in types
	if (NON_PLAIN_CONSTRUCTORS.has(proto.constructor)) {
		return false;
	}

	// Check for Buffer (Node.js specific)
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
		return false;
	}

	// If it's a custom class instance, it's not a plain object
	return false;
}

export function isObjectRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isPlainObject(value) ? value : null;
}

export function asRecordOrUndefined(
	value: unknown,
): Record<string, unknown> | undefined {
	return asRecord(value) ?? undefined;
}
