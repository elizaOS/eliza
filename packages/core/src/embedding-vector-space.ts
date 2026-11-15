/**
 * Carries a provider-verified embedding representation alongside numeric vectors.
 * The non-enumerable marker survives direct router calls and separately bundled
 * core copies without changing the serialized number-array API. Providers must
 * identify their actual encoder, pooling, and normalization before marking output.
 */
import { ElizaError } from "./errors.js";

export const BGE_SMALL_VECTOR_SPACE =
	"BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1";
const representation = Symbol.for("@elizaos/core/embedding-vector-space");

/** Null records a result produced before a named representation was selected. */
export function getEmbeddingVectorSpaceIdentity(
	vector: unknown,
): string | null | undefined {
	if (!Array.isArray(vector)) return undefined;
	const value: unknown = Reflect.get(vector, representation);
	return typeof value === "string" || value === null ? value : undefined;
}

export function getEmbeddingVectorSpace(vector: unknown): string | undefined {
	return getEmbeddingVectorSpaceIdentity(vector) ?? undefined;
}

/** Attach verified provenance to an actual provider vector, never a configured model name alone. */
export function identifyEmbeddingVector(
	vector: number[],
	spaceId: string | null,
): number[] {
	if (spaceId !== null && (!spaceId.trim() || spaceId !== spaceId.trim())) {
		throw new ElizaError(
			"Embedding representation requires a canonical identifier",
			{
				code: "EMBEDDING_SPACE_INVALID",
			},
		);
	}
	const previous = getEmbeddingVectorSpaceIdentity(vector);
	if (previous !== undefined && previous !== spaceId) {
		throw new ElizaError(
			"An embedding vector cannot be relabeled as another representation",
			{
				code: "EMBEDDING_SPACE_MISMATCH",
				context: { previous, requested: spaceId },
			},
		);
	}
	if (previous === undefined)
		Object.defineProperty(vector, representation, { value: spaceId });
	return vector;
}

/** Preserve provenance through an exact numeric copy; a modified vector requires its own encoder contract. */
export function copyEmbeddingVectorSpace(
	source: unknown,
	target: unknown,
): void {
	const spaceId = getEmbeddingVectorSpaceIdentity(source);
	if (spaceId === undefined) return;
	if (spaceId === null && Array.isArray(target)) {
		// Legacy post-processing may transform numbers, but cannot turn an
		// unversioned result into a provider-verified named representation.
		identifyEmbeddingVector(target, null);
		return;
	}
	if (
		!Array.isArray(source) ||
		!Array.isArray(target) ||
		source.length !== target.length ||
		!source.every(
			(value, index) =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value === target[index],
		)
	) {
		throw new ElizaError(
			"Embedding post-processing changed a provider-identified vector",
			{
				code: "EMBEDDING_VECTOR_TRANSFORMED",
			},
		);
	}
	identifyEmbeddingVector(target, spaceId);
}
