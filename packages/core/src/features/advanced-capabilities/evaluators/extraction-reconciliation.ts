/** Retire derived claims whose exact source revisions changed. Originals remain
 * in storage; only retained supporting source IDs are queued for re-extraction. */
import { ElizaError } from "../../../errors.ts";
import type {
	CustomMetadata,
	EvaluatorEvidenceReconciliation,
	EvaluatorRunContext,
} from "../../../types/index.ts";
import { isProtectedMemoryEvidence } from "../../../utils/extraction-evidence.ts";
import { isObjectRecord } from "../../../utils/type-guards.ts";

export async function reconcileFactEvidence({
	runtime,
	message,
	reconciliation,
}: EvaluatorRunContext & {
	reconciliation: EvaluatorEvidenceReconciliation;
}): Promise<{ reprocessSourceIds: string[] }> {
	const facts = await runtime.getMemories({
		tableName: "facts",
		agentId: runtime.agentId,
		entityId: message.entityId,
		authorEntityIds: [message.entityId],
		unique: false,
	});
	const reprocess = new Set<string>();
	for (const fact of facts) {
		if (
			fact.agentId !== runtime.agentId ||
			fact.entityId !== message.entityId ||
			isProtectedMemoryEvidence(fact)
		)
			continue;
		const metadata = isObjectRecord(fact.metadata) ? fact.metadata : {};
		const revisions = isObjectRecord(metadata.extractionSourceRevisions)
			? metadata.extractionSourceRevisions
			: {};
		const pending =
			reconciliation.pendingEvidenceId !== undefined &&
			Array.isArray(metadata.extractionEvidenceIds) &&
			metadata.extractionEvidenceIds.includes(reconciliation.pendingEvidenceId);
		const changed = Object.entries(revisions)
			.filter(
				([id, revision]) =>
					reconciliation.changedMessageIds.includes(id) ||
					reconciliation.removedMessageIds.includes(id) ||
					(reconciliation.currentSourceRevisions[id] !== undefined &&
						reconciliation.currentSourceRevisions[id] !== revision),
			)
			.map(([id]) => id);
		if (!pending && !changed.length) continue;
		for (const id of Object.keys(revisions))
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		if (metadata.extractionStatus === "source_invalidated") continue;
		if (
			!fact.id ||
			!(await runtime.updateMemory({
				id: fact.id,
				metadata: {
					...(fact.metadata as CustomMetadata),
					type: "custom",
					extractionStatus: "source_invalidated",
					extractionReviewRequired: false,
					extractionReconciliationId: reconciliation.id,
					extractionChangedSourceIds: changed,
				},
			}))
		)
			throw new ElizaError("Derived fact could not be retired", {
				code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
			});
	}
	return { reprocessSourceIds: [...reprocess] };
}
