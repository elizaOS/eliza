import { ElizaError } from "../errors";

/** Snapshot a JSON cache value without invoking accessors or toJSON hooks.
 * Sorted object keys give SQLite the same equality as PostgreSQL jsonb.
 * Undefined is reserved for an absent expected row, never a stored value.
 */
export function encodeCacheCasValue(value: unknown): string {
	const ancestors = new Set<object>();
	const string = (text: string): string => {
		if (text.includes("\u0000") || !text.isWellFormed())
			throw new Error("Invalid jsonb string");
		return JSON.stringify(text);
	};
	const encode = (item: unknown): string => {
		if (item === null) return "null";
		if (typeof item === "string") return string(item);
		if (typeof item === "boolean") return String(item);
		if (typeof item === "number" && Number.isFinite(item))
			return JSON.stringify(item);
		if (typeof item !== "object" || item === null)
			throw new Error("Expected JSON value");
		if (ancestors.has(item)) throw new Error("Cyclic cache value");
		const array = Array.isArray(item);
		const prototype = Object.getPrototypeOf(item);
		if (!array && prototype !== Object.prototype && prototype !== null)
			throw new Error("Expected plain object");
		ancestors.add(item);
		try {
			const descriptors = Object.getOwnPropertyDescriptors(item);
			if (Object.getOwnPropertySymbols(item).length)
				throw new Error("Symbol cache properties");
			const keys = Object.keys(descriptors).filter(
				(key) => !array || key !== "length",
			);
			for (const key of keys) {
				const descriptor = descriptors[key];
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
					throw new Error("Expected enumerable data property");
			}
			if (array) {
				if (
					keys.length !== item.length ||
					keys.some((key, index) => key !== String(index))
				)
					throw new Error("Expected dense JSON array");
				return `[${keys.map((key) => encode(descriptors[key]?.value)).join(",")}]`;
			}
			return `{${keys
				.sort()
				.map((key) => `${string(key)}:${encode(descriptors[key]?.value)}`)
				.join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	};
	try {
		return encode(value);
	} catch (cause) {
		// error-policy:J2 preserve the cause while rejecting lossy cache comparisons.
		throw new ElizaError(
			"Cache compare-and-set requires representable JSON values",
			{
				code: "CACHE_CAS_INVALID_VALUE",
				cause,
			},
		);
	}
}
