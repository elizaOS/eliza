/** Canonical first-party embedding vector-space and input contract. */
import { toWellFormedUnicode } from "../utils/well-formed";

export const CANONICAL_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5" as const;
export const CANONICAL_EMBEDDING_DIMENSION = 384 as const;
export const CANONICAL_EMBEDDING_POOLING = "cls" as const;
export const CANONICAL_EMBEDDING_NORMALIZATION = "l2" as const;
export const CANONICAL_EMBEDDING_MAX_CONTEXT_TOKENS = 512 as const;
/**
 * Conservative cross-runtime safety bound for one BGE input. BGE reserves two
 * of its 512 context positions for CLS/SEP. Core deliberately limits the
 * trimmed input to 510 UTF-16 code units so every browser, edge, and Node path
 * fails before a provider could truncate it. This is not an exact tokenizer
 * estimate: many longer inputs would tokenize successfully, but accepting them
 * without bundling the canonical WordPiece tokenizer would not be fail-closed.
 */
export const CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS = 510 as const;
export const CANONICAL_EMBEDDING_GGUF_FILENAME =
	"bge-small-en-v1.5-q4_k_m.gguf" as const;
export const CANONICAL_EMBEDDING_GGUF_REPO =
	"CompendiumLabs/bge-small-en-v1.5-gguf" as const;
export const CANONICAL_EMBEDDING_GGUF_SIZE_BYTES = 24_808_576 as const;
export const CANONICAL_EMBEDDING_GGUF_SHA256 =
	"363a0a4855dff6c653e06efe3209157debcf7f74e52d0d7c71e2747cd523043e" as const;

/**
 * Persist this alongside stored vectors. Equal dimensions do not imply an
 * equal vector space: changing any component requires clearing and re-embedding
 * every stored vector before semantic search is enabled.
 */
export const CANONICAL_EMBEDDING_SPACE_FINGERPRINT =
	"BAAI/bge-small-en-v1.5:384:cls:l2:v2" as const;

/**
 * The immediately preceding first-party space. It has the same model and
 * width as the canonical space, but mean pooling makes every vector
 * incompatible with CLS pooling. Adapters use this only to identify migration
 * provenance; they must never accept or query it as canonical.
 */
export const LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT =
	"BAAI/bge-small-en-v1.5:384:mean:l2:v1" as const;

/**
 * Prepare one canonical BGE input without truncating or silently repairing it.
 * Surrounding whitespace is insignificant and removed; non-string, blank,
 * ill-formed Unicode, and over-limit inputs fail before provider dispatch.
 */
export function prepareCanonicalEmbeddingInput(input: unknown): string {
	if (typeof input !== "string") {
		throw new TypeError("Canonical embedding input must be a string.");
	}
	const prepared = input.trim();
	if (!prepared) {
		throw new Error("Canonical embedding input cannot be blank.");
	}
	if (toWellFormedUnicode(prepared) !== prepared) {
		throw new Error(
			"Canonical embedding input must contain well-formed Unicode.",
		);
	}
	if (prepared.length > CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS) {
		throw new RangeError(
			`Canonical embedding input is ${prepared.length} UTF-16 code units; maximum is ${CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS} for the ${CANONICAL_EMBEDDING_MAX_CONTEXT_TOKENS}-token BGE context.`,
		);
	}
	return prepared;
}
export function assertCanonicalEmbeddingConfig(
	model: string,
	dimension: number,
	pooling: string = CANONICAL_EMBEDDING_POOLING,
): void {
	if (model.trim() !== CANONICAL_EMBEDDING_MODEL) {
		throw new Error(
			`Embedding model mismatch: got "${model}", expected "${CANONICAL_EMBEDDING_MODEL}". Refusing to mix incompatible vector spaces.`,
		);
	}
	if (dimension !== CANONICAL_EMBEDDING_DIMENSION) {
		throw new Error(
			`Embedding dimension mismatch: got ${dimension}, expected ${CANONICAL_EMBEDDING_DIMENSION}. Refusing to mix incompatible vector widths.`,
		);
	}
	if (pooling.trim().toLowerCase() !== CANONICAL_EMBEDDING_POOLING) {
		throw new Error(
			`Embedding pooling mismatch: got "${pooling}", expected "${CANONICAL_EMBEDDING_POOLING}". Refusing to mix incompatible vector spaces.`,
		);
	}
}

/** Validate and L2-normalize a canonical embedding; zero vectors fail closed. */
export function normalizeCanonicalEmbedding(
	vector: readonly number[],
): number[] {
	if (vector.length !== CANONICAL_EMBEDDING_DIMENSION) {
		throw new Error(
			`Embedding dimension mismatch: got ${vector.length}, expected ${CANONICAL_EMBEDDING_DIMENSION}.`,
		);
	}
	let squaredNorm = 0;
	for (const value of vector) {
		if (!Number.isFinite(value)) {
			throw new Error("Embedding contains a non-finite value.");
		}
		squaredNorm += value * value;
	}
	const norm = Math.sqrt(squaredNorm);
	if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
		throw new Error("Embedding has a zero or invalid L2 norm.");
	}
	// Preserve byte-stable vectors at repeated trust boundaries. Runtime model
	// dispatch normalizes first, while document/recall/persistence boundaries
	// defensively validate again; re-dividing an already-unit vector introduces
	// tiny floating-point drift that can make rendered, cached, and stored values
	// differ despite representing the same vector.
	if (Math.abs(norm - 1) <= 1e-12) {
		return [...vector];
	}
	return vector.map((value) => value / norm);
}
