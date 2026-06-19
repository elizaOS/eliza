import { hashPromptSegment } from "./context-hash";

export interface ContextDiffSegment {
	id?: string;
	label?: string;
	content: string;
	stable?: boolean;
	tokenCount?: number;
}

export type ContextSegmentDiffKind =
	| "unchanged"
	| "changed"
	| "added"
	| "removed"
	| "moved";

export interface ContextSegmentDiff {
	type: ContextSegmentDiffKind;
	key: string;
	previousIndex?: number;
	currentIndex?: number;
	previous?: ContextDiffSegment;
	current?: ContextDiffSegment;
	previousHash?: string;
	currentHash?: string;
	tokenDelta: number;
}

export interface ContextDiffSummary {
	unchanged: number;
	changed: number;
	added: number;
	removed: number;
	moved: number;
	tokenDelta: number;
}

export interface ContextDiffResult {
	changes: ContextSegmentDiff[];
	summary: ContextDiffSummary;
}

interface IndexedSegment {
	segment: ContextDiffSegment;
	index: number;
	hash: string;
	key: string;
	tokenCount: number;
}

export function estimateSegmentTokens(content: string): number {
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(trimmed.length / 4));
}

function getSegmentTokenCount(segment: ContextDiffSegment): number {
	return segment.tokenCount ?? estimateSegmentTokens(segment.content);
}

function indexSegment(
	segment: ContextDiffSegment,
	index: number,
): IndexedSegment {
	const hash = hashPromptSegment(segment).hash;
	return {
		segment,
		index,
		hash,
		key: segment.id ?? segment.label ?? hash,
		tokenCount: getSegmentTokenCount(segment),
	};
}

function buildPreviousQueues(
	previous: readonly ContextDiffSegment[],
): Map<string, IndexedSegment[]> {
	const queues = new Map<string, IndexedSegment[]>();
	previous.map(indexSegment).forEach((segment) => {
		const queue = queues.get(segment.key);
		if (queue) {
			queue.push(segment);
		} else {
			queues.set(segment.key, [segment]);
		}
	});
	return queues;
}

function summarize(changes: readonly ContextSegmentDiff[]): ContextDiffSummary {
	const summary: ContextDiffSummary = {
		unchanged: 0,
		changed: 0,
		added: 0,
		removed: 0,
		moved: 0,
		tokenDelta: 0,
	};

	for (const change of changes) {
		summary[change.type] += 1;
		summary.tokenDelta += change.tokenDelta;
	}

	return summary;
}

export function diffContextSegments(
	previous: readonly ContextDiffSegment[],
	current: readonly ContextDiffSegment[],
): ContextDiffResult {
	const previousQueues = buildPreviousQueues(previous);
	const changes: ContextSegmentDiff[] = [];

	current.map(indexSegment).forEach((currentSegment) => {
		const previousQueue = previousQueues.get(currentSegment.key);
		const previousSegment = previousQueue?.shift();

		if (!previousSegment) {
			changes.push({
				type: "added",
				key: currentSegment.key,
				currentIndex: currentSegment.index,
				current: currentSegment.segment,
				currentHash: currentSegment.hash,
				tokenDelta: currentSegment.tokenCount,
			});
			return;
		}

		const tokenDelta = currentSegment.tokenCount - previousSegment.tokenCount;
		if (previousSegment.hash !== currentSegment.hash) {
			changes.push({
				type: "changed",
				key: currentSegment.key,
				previousIndex: previousSegment.index,
				currentIndex: currentSegment.index,
				previous: previousSegment.segment,
				current: currentSegment.segment,
				previousHash: previousSegment.hash,
				currentHash: currentSegment.hash,
				tokenDelta,
			});
			return;
		}

		changes.push({
			type:
				previousSegment.index === currentSegment.index ? "unchanged" : "moved",
			key: currentSegment.key,
			previousIndex: previousSegment.index,
			currentIndex: currentSegment.index,
			previous: previousSegment.segment,
			current: currentSegment.segment,
			previousHash: previousSegment.hash,
			currentHash: currentSegment.hash,
			tokenDelta,
		});
	});

	for (const remainingPreviousSegments of previousQueues.values()) {
		for (const previousSegment of remainingPreviousSegments) {
			changes.push({
				type: "removed",
				key: previousSegment.key,
				previousIndex: previousSegment.index,
				previous: previousSegment.segment,
				previousHash: previousSegment.hash,
				tokenDelta: -previousSegment.tokenCount,
			});
		}
	}

	return {
		changes,
		summary: summarize(changes),
	};
}
