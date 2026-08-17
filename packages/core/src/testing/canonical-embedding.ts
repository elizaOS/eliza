/** Deterministic fixtures for tests that exercise the real embedding router. */
import {
	CANONICAL_EMBEDDING_DIMENSION,
	CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
	normalizeCanonicalEmbedding,
} from "../constants/embeddings.ts";

export const canonicalEmbeddingRegistrationMetadata = Object.freeze({
	embeddingSpaceFingerprint: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
});

/** A finite, non-zero, unit-length canonical-width vector. */
export function canonicalTestEmbedding(seed = 1): number[] {
	const vector = new Array<number>(CANONICAL_EMBEDDING_DIMENSION).fill(0);
	vector[0] = seed || 1;
	vector[1] = 1;
	return normalizeCanonicalEmbedding(vector);
}

/** Exact-width finite marker for the null dimension/space boot probe. */
export function canonicalEmbeddingProbeMarker(marker = 0): number[] {
	const vector = new Array<number>(CANONICAL_EMBEDDING_DIMENSION).fill(0);
	vector[0] = marker;
	return vector;
}
