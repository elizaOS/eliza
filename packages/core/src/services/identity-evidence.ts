/** Source-owned identity observations, independent of manually entered data. */
import z from "zod";
import type { EvaluatorEvidenceReconciliation } from "../types/evaluator.ts";

const supportSchema = z.object({
	confidence: z.number().min(0).max(1),
	verified: z.boolean(),
	source: z.string().optional(),
	evidenceMessageIds: z.array(z.string()),
	firstSeen: z.string(),
	lastSeen: z.string(),
});

const observationSchema = supportSchema.extend({
	evidenceId: z.string(),
	roomId: z.string(),
	sourceMessageId: z.string(),
	sourceRevisions: z.record(z.string(), z.string()),
	retiredBy: z.string().optional(),
});

const stateSchema = z.object({
	version: z.literal(1),
	baselines: z.record(z.string(), supportSchema),
	observations: z.record(z.string(), observationSchema),
	active: z.boolean(),
	reviewRequired: z.boolean().optional(),
});

export type IdentitySupport = z.infer<typeof supportSchema>;
export type IdentityEvidenceState = z.infer<typeof stateSchema>;
export type IdentityObservation = z.infer<typeof observationSchema>;

/** Invalid non-null state is an error, never permission to lose its evidence. */
export function parseIdentityEvidence(
	value: unknown,
): IdentityEvidenceState | null {
	return value === null || value === undefined
		? null
		: stateSchema.parse(value);
}

export function initialIdentityEvidence(legacy?: {
	id: string;
	support: IdentitySupport;
}): IdentityEvidenceState {
	return {
		version: 1,
		baselines: legacy ? { [legacy.id]: legacy.support } : {},
		observations: {},
		active: Boolean(legacy),
	};
}

export function projectIdentityEvidence(
	state: IdentityEvidenceState,
): IdentitySupport & { active: boolean } {
	const supports = [
		...Object.values(state.baselines),
		...Object.values(state.observations).filter((row) => !row.retiredBy),
	];
	const protectedSource = supports.find(
		(row) => row.source && row.source !== "reflection",
	)?.source;
	return {
		active: supports.length > 0,
		confidence: Math.max(0, ...supports.map((row) => row.confidence)),
		verified: supports.some((row) => row.verified),
		source:
			protectedSource ??
			(supports.some((row) => row.source === undefined)
				? undefined
				: "reflection"),
		evidenceMessageIds: [
			...new Set(supports.flatMap((row) => row.evidenceMessageIds)),
		],
		firstSeen: supports.map((row) => row.firstSeen).sort()[0] ?? "",
		lastSeen:
			supports
				.map((row) => row.lastSeen)
				.sort()
				.at(-1) ?? "",
	};
}

export function retireIdentityEvidence(
	state: IdentityEvidenceState,
	roomId: string,
	reconciliation: EvaluatorEvidenceReconciliation,
): { state: IdentityEvidenceState; reprocessSourceIds: string[] } {
	const next = structuredClone(state);
	const reprocess = new Set<string>();
	for (const observation of Object.values(next.observations)) {
		if (observation.roomId !== roomId) continue;
		if (observation.retiredBy && observation.retiredBy !== reconciliation.id)
			continue;
		const affected =
			observation.evidenceId === reconciliation.pendingEvidenceId ||
			Object.entries(observation.sourceRevisions).some(
				([id, revision]) =>
					reconciliation.changedMessageIds.includes(id) ||
					reconciliation.removedMessageIds.includes(id) ||
					(reconciliation.currentSourceRevisions[id] !== undefined &&
						reconciliation.currentSourceRevisions[id] !== revision),
			);
		if (!affected) continue;
		// Replays must return the same reprocessing set after the native row write
		// succeeds but the surrounding evaluator journal commit fails.
		for (const id of Object.keys(observation.sourceRevisions)) {
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		}
		observation.retiredBy ??= reconciliation.id;
	}
	next.active = projectIdentityEvidence(next).active;
	return { state: next, reprocessSourceIds: [...reprocess] };
}

export function mergeIdentityEvidence(
	left: IdentityEvidenceState,
	right: IdentityEvidenceState,
): IdentityEvidenceState {
	const result: IdentityEvidenceState = {
		version: 1,
		baselines: { ...right.baselines, ...left.baselines },
		observations: { ...right.observations, ...left.observations },
		active: true,
		...(left.reviewRequired || right.reviewRequired
			? { reviewRequired: true }
			: {}),
	};
	result.active = projectIdentityEvidence(result).active;
	return result;
}
