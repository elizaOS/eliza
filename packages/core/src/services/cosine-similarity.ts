/** Cosine similarity: dot(a,b) / (||a|| * ||b||). Returns [-1, 1], or 0 for degenerate inputs. */
export function cosineSimilarity(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) {
		return 0;
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < len; i++) {
		const ai = a[i];
		const bi = b[i];

		if (!Number.isFinite(ai) || !Number.isFinite(bi)) {
			return 0;
		}

		dotProduct += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);

	if (denominator === 0 || !Number.isFinite(denominator)) {
		return 0;
	}

	const result = dotProduct / denominator;

	if (result > 1) return 1;
	if (result < -1) return -1;

	return result;
}

/** L2-normalize a vector to unit magnitude. Returns a copy for zero vectors. */
export function normalizeVector(v: number[]): number[] {
	let sumSq = 0;
	for (let i = 0; i < v.length; i++) {
		sumSq += v[i] * v[i];
	}

	const norm = Math.sqrt(sumSq);
	if (norm === 0) {
		return v.slice();
	}

	const result = new Array<number>(v.length);
	for (let i = 0; i < v.length; i++) {
		result[i] = v[i] / norm;
	}
	return result;
}
