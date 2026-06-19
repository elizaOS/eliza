import { EXAMPLE_NAMES } from "./example-names";

const UINT32_MAX = 0x100000000;

export function buildDeterministicSeed(
	...parts: Array<string | number | null | undefined>
): string {
	const filtered = parts
		.map((part) =>
			part === undefined || part === null ? "" : String(part).trim(),
		)
		.filter((part) => part.length > 0);
	return filtered.length > 0 ? filtered.join("::") : "default";
}

export function hashStringToUint32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function createDeterministicRandom(seed: string | number): () => number {
	let state =
		typeof seed === "number" ? seed >>> 0 : hashStringToUint32(String(seed));

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / UINT32_MAX;
	};
}

export function deterministicShuffle<T>(
	items: readonly T[],
	seed: string | number,
): T[] {
	const random = createDeterministicRandom(seed);
	const shuffled = [...items];
	for (let i = shuffled.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

export function deterministicSample<T>(
	items: readonly T[],
	count: number,
	seed: string | number,
): T[] {
	if (count <= 0 || items.length === 0) {
		return [];
	}

	return deterministicShuffle(items, seed).slice(
		0,
		Math.min(count, items.length),
	);
}

export function deterministicPick<T>(
	items: readonly T[],
	seed: string | number,
): T | undefined {
	return deterministicSample(items, 1, seed)[0];
}

export function getDeterministicNames(
	count: number,
	seed: string | number,
): string[] {
	if (count <= 0) {
		return [];
	}

	const ordered = deterministicShuffle(
		EXAMPLE_NAMES,
		buildDeterministicSeed(seed, "names"),
	);
	return Array.from({ length: count }, (_, index) => {
		const name = ordered[index % ordered.length];
		return typeof name === "string" && name.length > 0
			? name
			: `user${index + 1}`;
	});
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortStable(entry));
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nestedValue]) => [key, sortStable(nestedValue)]),
		);
	}

	return value;
}
