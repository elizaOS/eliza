/** Host-owned, opt-in public-read contracts shared by message hosts and the canonical assistant. */
import type { PlannerTrajectory } from "./planner-types";

/** Resolves host-owned read requirements from the canonical trajectory at evaluation time. */
export type TypedReadReplyResolver = (context: {
	trajectory: PlannerTrajectory;
	nowMs: number;
	admittedToolNames: readonly string[];
}) => Omit<TypedReadReplyBinding, "admitCorrection"> | undefined;

export interface TypedReadReplyBinding {
	/** Planning may retrieve normally; every FINISH crosses the same evidence gate. */
	phase: "planning" | "final-answer";
	/** Needed reads already exposed by the canonical authorized action surface. */
	remainingReadActionNames?: readonly string[];
	/** Existing queued call IDs only; no new operation is created by this policy. */
	pendingReadCallIds?: readonly string[];
	policy: TypedReadReplyPolicy;
	facts: readonly TypedReadFact[];
	/** Existing host budgets/deadline must explicitly admit an answer-only correction. */
	admitCorrection?: () => boolean;
}

export type TypedReadFact = {
	id: string;
	ownerScope: string;
	sourceUrl: string;
} & (
	| ({ kind: "quantity"; value: number; unit: string } & (
			| { observedAtMs?: number; modelEstimate?: never }
			| {
					observedAtMs?: never;
					modelEstimate: {
						validAtMs: number;
						modelUpdatedAtMs: number;
						creditConnectorId: string;
					};
			  }
	  ))
	| {
			kind: "quantity-report";
			value: number;
			unit: string;
			reportedDay?: string;
			/** Producer-validated nearby locality, never inferred from an evaluator draft. */
			providerLocality?: string;
			/** A fully qualified source place may be shown only as an explicit alternative for an ambiguous bare city. */
			qualification?: "named-place-alternative";
			observedAtMs?: number;
	  }
	| { kind: "publication-report"; title: string; publicationDay: string }
	| { kind: "publication"; title: string; publicationDay?: string }
);

export type TypedReadRequirement = {
	id: string;
	/** A server-owned label, never supplied by the evaluator. */
	label: string;
	/** Existing producer authority binds these fact IDs to this requested subject and operation. */
	admittedFactIds: readonly string[];
	/** Scoped alternatives never fulfill the original current/day requirement. */
	qualifiedFactIds?: readonly string[];
	/** Trusted complete uncertainty sentence; the evaluator cannot supply its prose. */
	unverifiedText: string;
} & (
	| {
			kind: "quantity";
			unit: string;
			freshnessMs: number;
			current: boolean;
			modelEstimate?: {
				maxSourceAgeMs: number;
				maxValidDistanceMs: number;
				futureSkewMs: number;
			};
	  }
	| { kind: "publication"; requestedDay?: string }
);

export interface TypedReadReplyPolicy {
	/** Current server-owned input identity; never supplied by an evaluator draft. */
	turnId: string;
	ownerScope: string;
	nowMs: number;
	includeSources: boolean;
	requirements: readonly TypedReadRequirement[];
	/** Trusted nonfactual connective text selected by ID, not model-authored claims. */
	connectors: Readonly<Record<string, string>>;
}

export type TypedReadReplyPart =
	| {
			kind: "fact" | "qualified";
			requirementId: string;
			factId: string;
			value: number | string;
	  }
	| { kind: "unverified"; requirementId: string }
	| { kind: "connector"; connectorId: string };

export type TypedReadReplyVerdict =
	| { verdict: "not-applicable"; text: string }
	| {
			verdict: "allow";
			text: string;
			factIds: readonly string[];
			partial?: true;
	  }
	| {
			verdict: "reject";
			reason:
				| "invalid-contract"
				| "missing-claim-declaration"
				| "unknown-reference"
				| "owner-mismatch"
				| "unsupported-value"
				| "unverified-time"
				| "draft-not-bound"
				| "nonfinal-answer";
	  };

/** Opaque in-process attestation; only the canonical typed renderer can mint a verifiable receipt. */
export interface TypedReadEgressReceipt {
	readonly version: 1;
	readonly ownerScope: string;
	readonly turnId: string;
	readonly requirementIds: readonly string[];
	readonly factIds: readonly string[];
	readonly partial: boolean;
}
