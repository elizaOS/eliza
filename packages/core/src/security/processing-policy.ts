/**
 * Host-owned processing admission for model attempts and action effects.
 *
 * This extends the confidential-inference boundary (`confidential-inference.ts`)
 * from "which handler/route may run" to "may this payload be processed here at
 * all". It is consulted before any payload preparation: before secret/PII
 * substitution, pipeline hooks, and the handler for a model attempt, and before
 * the handler for an action effect. When no policy is installed nothing is
 * consulted and behavior is unchanged. When one is installed, anything the
 * policy cannot evaluate (unknown modality, undeclared action destinations, a
 * throwing or malformed policy) is denied, and a denial is terminal: dispatch
 * never fails over to another provider after a processing denial.
 *
 * Only the runtime constructor installs a policy. Plugin metadata and runtime
 * settings never grant authority.
 */
import { ElizaError } from "../errors";
import { logger } from "../logger";
import type { ProcessingModality } from "../runtime/model-modality";
import { getTrajectoryContext } from "../trajectory-context";

export const PROCESSING_POLICY_DENIED = "PROCESSING_POLICY_DENIED";

/** Correlation the runtime can attest for the current turn, when present. */
export interface ProcessingScope {
	readonly agentId: string;
	readonly roomId?: string;
	readonly messageId?: string;
	/** Pipeline stage of the active trajectory (e.g. "response", "action"). */
	readonly stage?: string;
}

export interface ProcessingModelAttempt {
	/** The registered slot actually being called (after model-type fallback). */
	readonly modelType: string;
	/** The slot the caller asked for. */
	readonly requestedModelType: string;
	readonly modality: ProcessingModality;
	readonly provider: string;
	/** Exact handler identity; a provider name cannot impersonate one. */
	readonly handler: (...args: never[]) => unknown;
	/** 1-based attempt number within this useModel call. */
	readonly attempt: number;
	/** `failover` for any attempt after a failed provider. */
	readonly reason: "primary" | "failover";
}

export interface ProcessingActionEffect {
	readonly name: string;
	/** The action's declared destinations (`Action.egress`). */
	readonly egress: readonly string[];
}

export type ProcessingRequest = ProcessingScope &
	(
		| { readonly kind: "model_attempt"; readonly model: ProcessingModelAttempt }
		| {
				readonly kind: "action_effect";
				readonly action: ProcessingActionEffect;
		  }
	);

export type ProcessingDecision =
	| {
			readonly allow: true;
			/** Policy-owned receipt identifying this admission in the host audit. */
			readonly receiptId: string;
			readonly policyRevision: string;
	  }
	| {
			readonly allow: false;
			readonly code: string;
			readonly policyRevision: string | null;
	  };

/** Implemented by measured host code; must read current policy on every call. */
export interface ProcessingPolicy {
	decide(
		request: ProcessingRequest,
	): ProcessingDecision | Promise<ProcessingDecision>;
}

export type ProcessingDenialReason =
	| "policy_denied"
	| "policy_unavailable"
	| "decision_malformed"
	| "modality_unknown"
	| "destination_undeclared";

/** Terminal processing denial. The payload was not sent. */
export class ProcessingPolicyDeniedError extends ElizaError {
	override readonly name: string = "ProcessingPolicyDeniedError";
	readonly reason: ProcessingDenialReason;
	readonly policyCode: string | undefined;

	constructor(args: {
		reason: ProcessingDenialReason;
		kind: ProcessingRequest["kind"];
		subject: string;
		policyCode?: string;
		policyRevision?: string | null;
		cause?: unknown;
	}) {
		super(
			`Processing policy denied ${args.kind === "model_attempt" ? "model call" : "action"} ${args.subject} (${args.reason})`,
			{
				code: PROCESSING_POLICY_DENIED,
				cause: args.cause,
				context: {
					reason: args.reason,
					kind: args.kind,
					subject: args.subject,
					policyCode: args.policyCode,
					policyRevision: args.policyRevision ?? null,
				},
				severity: "fatal",
			},
		);
		this.reason = args.reason;
		this.policyCode = args.policyCode;
	}
}

/** True when `error` or anything in its cause chain is a processing denial. */
export function isProcessingPolicyDenial(error: unknown): boolean {
	const pending: unknown[] = [error];
	const seen = new Set<object>();
	while (pending.length) {
		const value = pending.pop();
		if (typeof value !== "object" || value === null || seen.has(value))
			continue;
		seen.add(value);
		if ("code" in value && value.code === PROCESSING_POLICY_DENIED) return true;
		if ("cause" in value) pending.push(value.cause);
		if ("lastError" in value) pending.push(value.lastError);
		if ("errors" in value && Array.isArray(value.errors))
			pending.push(...value.errors);
	}
	return false;
}

// Module-private key. A non-writable, non-configurable own property survives
// wrappers (Proxy / Object.create) that forward reads to the runtime, so a
// scoped runtime view cannot silently drop the host policy.
const processingPolicyKey: unique symbol = Symbol("eliza.processing-policy");

/**
 * Bind a host policy to a runtime. Called only by the runtime constructor; a
 * bound policy can never be replaced or removed.
 */
export function bindProcessingPolicy(
	runtime: object,
	policy: ProcessingPolicy,
): void {
	if (Object.hasOwn(runtime, processingPolicyKey)) {
		throw new ElizaError("A processing policy is already bound", {
			code: "PROCESSING_POLICY_ALREADY_BOUND",
			severity: "fatal",
		});
	}
	if (typeof policy?.decide !== "function") {
		throw new ElizaError("A processing policy must implement decide()", {
			code: "PROCESSING_POLICY_INVALID",
			severity: "fatal",
		});
	}
	Object.defineProperty(runtime, processingPolicyKey, {
		value: policy,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

export function processingPolicyFor(
	runtime: object,
): ProcessingPolicy | undefined {
	const policy = (runtime as { [processingPolicyKey]?: unknown })[
		processingPolicyKey
	];
	return policy === undefined ? undefined : (policy as ProcessingPolicy);
}

function isDecision(value: unknown): value is ProcessingDecision {
	if (typeof value !== "object" || value === null) return false;
	const decision = value as Record<string, unknown>;
	if (decision.allow === true) {
		return (
			typeof decision.receiptId === "string" &&
			decision.receiptId.length > 0 &&
			typeof decision.policyRevision === "string" &&
			decision.policyRevision.length > 0
		);
	}
	return (
		decision.allow === false &&
		typeof decision.code === "string" &&
		(decision.policyRevision === null ||
			typeof decision.policyRevision === "string")
	);
}

type AdmissionInput =
	| {
			kind: "model_attempt";
			model: Omit<ProcessingModelAttempt, "modality"> & {
				modality: ProcessingModality | undefined;
			};
	  }
	| {
			kind: "action_effect";
			action: { name: string; egress: readonly string[] | undefined };
	  };

/**
 * Admit one model attempt or action effect. Returns `undefined` without a
 * policy, the allow decision otherwise, and throws
 * {@link ProcessingPolicyDeniedError} on every denial.
 */
export async function admitProcessing(
	policy: ProcessingPolicy | undefined,
	agentId: string,
	input: AdmissionInput,
	cause?: unknown,
): Promise<Extract<ProcessingDecision, { allow: true }> | undefined> {
	if (!policy) return undefined;
	const subject =
		input.kind === "model_attempt"
			? `${input.model.modelType}@${input.model.provider}`
			: input.action.name;
	const deny = (
		reason: ProcessingDenialReason,
		extra: {
			policyCode?: string;
			policyRevision?: string | null;
			cause?: unknown;
		} = {},
	): never => {
		const error = new ProcessingPolicyDeniedError({
			reason,
			kind: input.kind,
			subject,
			...extra,
			cause: extra.cause ?? cause,
		});
		logger.warn(
			{
				src: "processing-policy",
				agentId,
				kind: input.kind,
				subject,
				reason,
				policyCode: extra.policyCode,
			},
			"Processing denied before payload dispatch",
		);
		throw error;
	};
	const trajectory = getTrajectoryContext();
	const scope: ProcessingScope = {
		agentId,
		...(trajectory?.roomId ? { roomId: trajectory.roomId } : {}),
		...(trajectory?.messageId ? { messageId: trajectory.messageId } : {}),
		...(trajectory?.purpose ? { stage: trajectory.purpose } : {}),
	};
	let request: ProcessingRequest;
	if (input.kind === "model_attempt") {
		const { modality } = input.model;
		if (modality === undefined) return deny("modality_unknown");
		request = {
			...scope,
			kind: input.kind,
			model: { ...input.model, modality },
		};
	} else {
		const { egress } = input.action;
		if (!Array.isArray(egress)) return deny("destination_undeclared");
		request = {
			...scope,
			kind: input.kind,
			action: { name: input.action.name, egress: [...egress] },
		};
	}
	let decision: unknown;
	try {
		decision = await policy.decide(Object.freeze(request));
	} catch (error) {
		// error-policy:J1 A policy that cannot decide never admits the payload.
		return deny("policy_unavailable", { cause: error });
	}
	if (!isDecision(decision)) return deny("decision_malformed");
	if (!decision.allow) {
		return deny("policy_denied", {
			policyCode: decision.code,
			policyRevision: decision.policyRevision,
		});
	}
	return decision;
}
