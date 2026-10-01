/**
 * Browser-safe `@elizaos/core/type-guards` leaf. Keeps this leaf's historical
 * loose semantics: `asRecord` accepts any non-null, non-array object, and
 * `isPlainObject` checks only the `[object Object]` tag. The strict variants
 * live under the same names in the root export (`utils/type-guards.ts`).
 */
export {
	asNonEmptyString,
	asObjectArray,
	asObjectRecord as asRecord,
	asObjectRecordOrUndefined as asRecordOrUndefined,
	hasPlainObjectTag as isPlainObject,
	type UnknownRecord,
} from "./utils/type-guards.js";
