/**
 * Maps configured-secret matches across ordered diagnostic fragments back to
 * absolute source ranges. AgentRuntime owns the secret values; callers receive
 * only taint metadata so stream offsets remain usable without exposing config.
 */

const MIN_CONFIGURED_SECRET_LENGTH = 8;
const MAX_FRAGMENT_COUNT = 256;
const MAX_TOTAL_FRAGMENT_CHARACTERS = 256 * 1024;
const MAX_CONFIGURED_SECRET_COUNT = 128;
const MAX_CONFIGURED_SECRET_LENGTH = 32 * 1024;
const MAX_WORK_UNITS = 2_000_000;

export interface SecretFragment {
	/** Stable source identity, such as stdout or stderr. */
	source: string;
	/** Absolute character offset of text within its source. */
	startOffset: number;
	/** Private fragment text inspected by AgentRuntime. */
	text: string;
}

export interface SecretTaintRange {
	source: string;
	startOffset: number;
	endOffset: number;
}

export type SecretFragmentTaint =
	| {
			status: "complete";
			ranges: SecretTaintRange[];
			maxSecretLength: number;
	  }
	| {
			status: "incomplete";
			reason: "invalid-input" | "resource-limit";
			ranges: [];
			maxSecretLength: number;
	  };

interface CandidateRange extends SecretTaintRange {
	fragmentIndex: number;
}

interface SuccessfulEdge {
	endSecretOffset: number;
	occurrences: number[];
}

interface WorkBudget {
	remaining: number;
}

function incomplete(
	reason: "invalid-input" | "resource-limit",
	maxSecretLength = 0,
): SecretFragmentTaint {
	return { status: "incomplete", reason, ranges: [], maxSecretLength };
}

function consumeWork(budget: WorkBudget, units = 1): boolean {
	budget.remaining -= units;
	return budget.remaining >= 0;
}

function normalizeFragments(
	fragments: readonly SecretFragment[],
): SecretFragment[] | "invalid-input" | "resource-limit" {
	if (!Array.isArray(fragments)) return "invalid-input";
	if (fragments.length > MAX_FRAGMENT_COUNT) return "resource-limit";
	const normalized: SecretFragment[] = [];
	let totalCharacters = 0;
	for (let index = 0; index < fragments.length; index++) {
		if (!(index in fragments)) return "invalid-input";
		const candidate: unknown = fragments[index];
		if (!candidate || typeof candidate !== "object") return "invalid-input";
		const fragment = candidate as Partial<SecretFragment>;
		if (
			typeof fragment.source !== "string" ||
			fragment.source.length === 0 ||
			!Number.isSafeInteger(fragment.startOffset) ||
			(fragment.startOffset ?? -1) < 0 ||
			typeof fragment.text !== "string" ||
			fragment.text.length === 0 ||
			!Number.isSafeInteger((fragment.startOffset ?? 0) + fragment.text.length)
		) {
			return "invalid-input";
		}
		totalCharacters += fragment.text.length;
		if (totalCharacters > MAX_TOTAL_FRAGMENT_CHARACTERS) {
			return "resource-limit";
		}
		normalized.push({
			source: fragment.source,
			startOffset: fragment.startOffset as number,
			text: fragment.text,
		});
	}
	return normalized;
}

function configuredSecretValues(
	secrets: Record<string, string>,
): string[] | "invalid-input" | "resource-limit" {
	if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
		return "invalid-input";
	}
	const values = Object.values(secrets);
	if (values.length > MAX_CONFIGURED_SECRET_COUNT) return "resource-limit";
	const unique = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") return "invalid-input";
		if (value.length > MAX_CONFIGURED_SECRET_LENGTH) return "resource-limit";
		if (value.length >= MIN_CONFIGURED_SECRET_LENGTH) unique.add(value);
	}
	return [...unique].sort((left, right) => right.length - left.length);
}

function occurrences(
	text: string,
	needle: string,
	budget: WorkBudget,
): number[] | null {
	if (!consumeWork(budget)) return null;
	const indexes: number[] = [];
	let from = 0;
	while (from <= text.length - needle.length) {
		const index = text.indexOf(needle, from);
		if (index < 0) break;
		if (!consumeWork(budget)) return null;
		indexes.push(index);
		from = index + 1;
	}
	return indexes;
}

function rangeKey(range: CandidateRange): string {
	return `${range.fragmentIndex}:${range.startOffset}:${range.endOffset}`;
}

function stateKey(fragmentIndex: number, secretOffset: number): string {
	return `${fragmentIndex}:${secretOffset}`;
}

/**
 * Builds the successful suffix graph once, then collects ranges in a second
 * pass. Repeated substrings therefore cannot recursively expand the same suffix.
 */
function findSecretRanges(
	fragments: readonly SecretFragment[],
	secret: string,
	budget: WorkBudget,
): CandidateRange[] | null {
	const edges = new Map<string, SuccessfulEdge[]>();
	for (
		let fragmentIndex = fragments.length - 1;
		fragmentIndex >= 0;
		fragmentIndex--
	) {
		const fragment = fragments[fragmentIndex];
		for (
			let secretOffset = secret.length - 1;
			secretOffset >= 0;
			secretOffset--
		) {
			if (!consumeWork(budget)) return null;
			const successful: SuccessfulEdge[] = [];
			const maxEnd = Math.min(
				secret.length,
				secretOffset + fragment.text.length,
			);
			for (let end = secretOffset + 1; end <= maxEnd; end++) {
				const segment = secret.slice(secretOffset, end);
				const segmentOccurrences = occurrences(fragment.text, segment, budget);
				if (!segmentOccurrences) return null;
				if (segmentOccurrences.length === 0) break;
				if (
					end === secret.length ||
					edges.has(stateKey(fragmentIndex + 1, end))
				) {
					successful.push({
						endSecretOffset: end,
						occurrences: segmentOccurrences,
					});
				}
			}
			if (successful.length > 0) {
				edges.set(stateKey(fragmentIndex, secretOffset), successful);
			}
		}
	}

	const matches = new Map<string, CandidateRange>();
	const visited = new Set<string>();
	const pending: Array<[number, number]> = [];
	for (let start = 0; start < fragments.length; start++) {
		if (edges.has(stateKey(start, 0))) pending.push([start, 0]);
	}
	while (pending.length > 0) {
		if (!consumeWork(budget)) return null;
		const [fragmentIndex, secretOffset] = pending.pop() as [number, number];
		const key = stateKey(fragmentIndex, secretOffset);
		if (visited.has(key)) continue;
		visited.add(key);
		const fragment = fragments[fragmentIndex];
		for (const edge of edges.get(key) ?? []) {
			const length = edge.endSecretOffset - secretOffset;
			for (const index of edge.occurrences) {
				if (!consumeWork(budget)) return null;
				const range: CandidateRange = {
					source: fragment.source,
					startOffset: fragment.startOffset + index,
					endOffset: fragment.startOffset + index + length,
					fragmentIndex,
				};
				matches.set(rangeKey(range), range);
			}
			if (edge.endSecretOffset < secret.length) {
				pending.push([fragmentIndex + 1, edge.endSecretOffset]);
			}
		}
	}
	return [...matches.values()];
}

function mergeRanges(ranges: readonly CandidateRange[]): SecretTaintRange[] {
	const sorted = ranges
		.map(({ source, startOffset, endOffset }) => ({
			source,
			startOffset,
			endOffset,
		}))
		.sort(
			(left, right) =>
				left.source.localeCompare(right.source) ||
				left.startOffset - right.startOffset ||
				left.endOffset - right.endOffset,
		);
	const merged: SecretTaintRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (
			previous &&
			previous.source === range.source &&
			range.startOffset <= previous.endOffset
		) {
			previous.endOffset = Math.max(previous.endOffset, range.endOffset);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

/**
 * Locate configured-secret material across consecutive ordered fragments.
 *
 * Each fragment must contribute a non-empty contiguous segment. An incomplete
 * result is fail-closed: callers suppress output rather than infer safety from
 * empty ranges.
 */
export function locateConfiguredSecretFragmentTaint(
	fragments: readonly SecretFragment[],
	secrets: Record<string, string>,
): SecretFragmentTaint {
	const normalized = normalizeFragments(fragments);
	if (typeof normalized === "string") return incomplete(normalized);
	const values = configuredSecretValues(secrets);
	if (typeof values === "string") return incomplete(values);
	const maxSecretLength = values.reduce(
		(maximum, secret) => Math.max(maximum, secret.length),
		0,
	);
	const availableCharacters = normalized.reduce(
		(total, fragment) => total + fragment.text.length,
		0,
	);
	const budget: WorkBudget = { remaining: MAX_WORK_UNITS };
	const ranges: CandidateRange[] = [];
	for (const secret of values) {
		if (secret.length > availableCharacters) continue;
		const found = findSecretRanges(normalized, secret, budget);
		if (!found) return incomplete("resource-limit", maxSecretLength);
		ranges.push(...found);
	}
	return { status: "complete", ranges: mergeRanges(ranges), maxSecretLength };
}
