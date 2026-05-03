/**
 * Shared text similarity helpers.
 *
 * WHY: Multiple prompt/evaluator flows need cheap similarity checks. Keep the
 * common algorithms in one place so repetition detection and fuzzy comparison do
 * not drift across features.
 */

export function tokenize(text: string): string[] {
	return (text ?? "")
		.toLowerCase()
		.replace(/\W+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * Jaccard similarity over token sets.
 */
export function wordOverlapSimilarity(a: string, b: string): number {
	const setA = new Set(tokenize(a));
	const setB = new Set(tokenize(b));
	const intersection = new Set([...setA].filter((value) => setB.has(value)));
	const union = new Set([...setA, ...setB]);
	if (union.size === 0) return 0;
	return intersection.size / union.size;
}

/**
 * Cosine similarity between numeric vectors (e.g. embeddings).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < a.length; index++) {
		dotProduct += a[index] * b[index];
		normA += a[index] * a[index];
		normB += b[index] * b[index];
	}
	const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
	if (magnitude === 0) return 0;
	return dotProduct / magnitude;
}

export function levenshteinDistance(a: string, b: string): number {
	const matrix: number[][] = [];

	for (let row = 0; row <= b.length; row++) {
		matrix[row] = [row];
	}
	for (let column = 0; column <= a.length; column++) {
		matrix[0][column] = column;
	}

	for (let row = 1; row <= b.length; row++) {
		for (let column = 1; column <= a.length; column++) {
			if (b.charAt(row - 1) === a.charAt(column - 1)) {
				matrix[row][column] = matrix[row - 1][column - 1];
			} else {
				matrix[row][column] = Math.min(
					matrix[row - 1][column - 1] + 1,
					matrix[row][column - 1] + 1,
					matrix[row - 1][column] + 1,
				);
			}
		}
	}

	return matrix[b.length][a.length];
}

export function similarityRatio(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;

	const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
	const maxLength = Math.max(a.length, b.length);
	return 1 - distance / maxLength;
}
