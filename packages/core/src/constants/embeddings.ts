/**
 * Canonical embedding contract for every first-party elizaOS runtime path.
 *
 * Embeddings are persisted and compared across local and hosted runtimes. A
 * model or width change therefore is not a cosmetic provider override: it
 * creates an incompatible vector space. Keep first-party providers pinned to
 * the same gte-small weights and 384-dimensional output.
 */
export const CANONICAL_EMBEDDING_MODEL = "thenlper/gte-small" as const;
export const CANONICAL_LOCAL_EMBEDDING_MODEL = "gte-small_fp16.gguf" as const;
export const CANONICAL_LOCAL_EMBEDDING_REPOSITORY =
	"ChristianAzinn/gte-small-gguf" as const;
export const CANONICAL_EMBEDDING_DIMENSION = 384 as const;

const CANONICAL_EMBEDDING_MODEL_ALIASES = new Set([
	CANONICAL_EMBEDDING_MODEL,
	"gte-small",
	CANONICAL_LOCAL_EMBEDDING_MODEL,
	CANONICAL_LOCAL_EMBEDDING_REPOSITORY,
]);

export function isCanonicalEmbeddingModel(model: string): boolean {
	return CANONICAL_EMBEDDING_MODEL_ALIASES.has(model.trim());
}

/** Fail closed before a mismatched vector can reach persistent storage. */
export function assertCanonicalEmbeddingConfig(
	model: string,
	dimension: number,
	settingPrefix = "embedding",
): void {
	if (!isCanonicalEmbeddingModel(model)) {
		throw new Error(
			`${settingPrefix} model mismatch: got "${model}", expected gte-small (${CANONICAL_EMBEDDING_MODEL}). ` +
				"All elizaOS embedding providers must share the same vector space.",
		);
	}
	if (dimension !== CANONICAL_EMBEDDING_DIMENSION) {
		throw new Error(
			`${settingPrefix} dimension mismatch: got ${dimension}, expected ${CANONICAL_EMBEDDING_DIMENSION} for gte-small. ` +
				"Refusing to mix incompatible embedding widths.",
		);
	}
}
