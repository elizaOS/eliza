/**
 * Host-owned admission for confidential model handlers and their actual HTTP
 * attempts. Route policy and mandatory audit storage are supplied by the host;
 * plugin metadata and runtime settings never grant authority. This boundary
 * trusts admitted code and does not replace deployment network isolation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ElizaError } from "../errors";
import { logger } from "../logger";

export type ConfidentialInferenceHandler = (...args: never[]) => unknown;

export interface ConfidentialInferenceRoute {
	readonly id: string;
	readonly endpoint: string;
	readonly model: string;
	readonly modelTypes: readonly string[];
}

export interface ConfidentialInferenceProfile {
	readonly revision: string;
	readonly expiresAt: number;
	readonly routes: readonly ConfidentialInferenceRoute[];
}

export interface ConfidentialInferenceAuditRecord {
	/** Shared across phases; sinks key records by (attemptId, phase), not attemptId alone. */
	readonly attemptId: string;
	readonly agentId: string;
	readonly modelType: string;
	readonly policyRevision: string | null;
	readonly routeId: string | null;
	readonly timestamp: number;
	readonly phase:
		| "dispatch_intent"
		| "response_headers"
		| "transport_error"
		| "denied";
	readonly denialCode?: string;
	readonly status?: number;
	readonly evidenceDigest?: string;
	readonly connectionBindingDigest?: string;
}

export interface ConfidentialInferenceTransportEvidence {
	readonly evidenceDigest: string;
	readonly connectionBindingDigest: string;
}

/** Only a measured host transport may produce this verified pre-send callback. */
export type ConfidentialInferenceTransport = (
	input: string,
	init: RequestInit,
	context: {
		readonly route: ConfidentialInferenceRoute;
		readonly policyRevision: string;
		beforeDispatch(
			evidence: ConfidentialInferenceTransportEvidence,
		): Promise<void>;
	},
) => Promise<Response>;

/** One runtime call owns this state across SDK retries and provider failover. */
export class ConfidentialInferenceOperation {
	#authorized = false;
	authorizeOnce(): boolean {
		if (this.#authorized) return false;
		this.#authorized = true;
		return true;
	}
}

/** Host implementation must resolve only after its same-agent durable commit. */
export interface ConfidentialInferenceAuditSink {
	append(record: ConfidentialInferenceAuditRecord): Promise<void>;
}

export interface ConfidentialInferenceAuthorityOptions {
	/** Exact trusted handler identities; a provider name cannot impersonate one. */
	readonly handlers: readonly ConfidentialInferenceHandler[];
	/** Read current server-owned policy on every handler and HTTP attempt. */
	readonly currentProfile: () => ConfidentialInferenceProfile;
	readonly audit: ConfidentialInferenceAuditSink;
	readonly transport?: ConfidentialInferenceTransport;
	readonly redispatchPolicy?: "deny-after-authorization";
}

function rejection(code: string): ElizaError {
	return new ElizaError(
		"Confidential inference requires an approved route and durable audit",
		{
			code,
		},
	);
}

/** Construct only from measured host configuration, never request/settings data. */
export class ConfidentialInferenceAuthority {
	readonly #handlers: ReadonlySet<ConfidentialInferenceHandler>;
	readonly #profile: () => ConfidentialInferenceProfile;
	readonly #audit: ConfidentialInferenceAuditSink;
	readonly transport: ConfidentialInferenceTransport | undefined;
	readonly deniesRedispatch: boolean;

	constructor(options: ConfidentialInferenceAuthorityOptions) {
		this.#handlers = new Set(options.handlers);
		this.#profile = options.currentProfile;
		this.#audit = options.audit;
		this.transport = options.transport;
		this.deniesRedispatch =
			options.redispatchPolicy === "deny-after-authorization";
	}

	profile(): ConfidentialInferenceProfile {
		const profile = this.#profile();
		if (
			typeof profile.revision !== "string" ||
			!profile.revision.trim() ||
			!Array.isArray(profile.routes) ||
			!profile.routes.every(
				(route) =>
					typeof route.id === "string" &&
					route.id.trim().length > 0 &&
					typeof route.endpoint === "string" &&
					typeof route.model === "string" &&
					route.model.length > 0 &&
					Array.isArray(route.modelTypes) &&
					route.modelTypes.length > 0 &&
					route.modelTypes.every(
						(modelType: unknown) =>
							typeof modelType === "string" && modelType.length > 0,
					),
			) ||
			!Number.isFinite(profile.expiresAt) ||
			profile.expiresAt <= Date.now()
		) {
			throw rejection("CONFIDENTIAL_INFERENCE_POLICY_UNAVAILABLE");
		}
		return structuredClone(profile);
	}

	acceptsHandler(handler: ConfidentialInferenceHandler): boolean {
		return this.#handlers.has(handler);
	}

	async record(
		record: ConfidentialInferenceAuditRecord,
		dispatched: boolean,
	): Promise<void> {
		try {
			await this.#audit.append(Object.freeze({ ...record }));
		} catch {
			// error-policy:J1 Audit failures expose no storage error or sensitive payload.
			throw rejection(
				dispatched
					? "CONFIDENTIAL_INFERENCE_OUTCOME_UNRECORDED"
					: "CONFIDENTIAL_INFERENCE_AUDIT_UNAVAILABLE",
			);
		}
	}
}

interface AttemptScope {
	readonly authority: ConfidentialInferenceAuthority;
	readonly agentId: string;
	readonly modelType: string;
	readonly operation: ConfidentialInferenceOperation;
}
const attemptScope = new AsyncLocalStorage<AttemptScope>();

async function deny(
	scope: AttemptScope,
	code: string,
	profile: ConfidentialInferenceProfile | null = null,
	attemptId: string = randomUUID(),
	routeId: string | null = null,
): Promise<never> {
	await scope.authority.record(
		{
			attemptId,
			agentId: scope.agentId,
			modelType: scope.modelType,
			policyRevision: profile?.revision ?? null,
			routeId,
			timestamp: Date.now(),
			phase: "denied",
			denialCode: code,
		},
		false,
	);
	throw rejection(code);
}

async function currentProfile(
	scope: AttemptScope,
	prior?: ConfidentialInferenceAuditRecord,
): Promise<ConfidentialInferenceProfile> {
	try {
		return scope.authority.profile();
	} catch {
		// error-policy:J1 Policy-source failures are sanitized and durably denied.
		return deny(
			scope,
			"CONFIDENTIAL_INFERENCE_POLICY_UNAVAILABLE",
			null,
			prior?.attemptId,
			prior?.routeId,
		);
	}
}

export async function runWithConfidentialInference<T>(
	authority: ConfidentialInferenceAuthority | undefined,
	context: {
		agentId: string;
		modelType: string;
		handler: ConfidentialInferenceHandler;
		operation?: ConfidentialInferenceOperation;
	},
	run: () => T,
): Promise<Awaited<T>> {
	if (!authority) return await run();
	const scope = {
		authority,
		agentId: context.agentId,
		modelType: context.modelType,
		operation: context.operation ?? new ConfidentialInferenceOperation(),
	};
	const profile = await currentProfile(scope);
	if (!authority.acceptsHandler(context.handler)) {
		return deny(scope, "CONFIDENTIAL_INFERENCE_HANDLER_DENIED", profile);
	}
	return await attemptScope.run(scope, run);
}

/**
 * Provider transport calls this immediately before the real HTTP operation.
 * Normal mode preserves the existing fetch arguments. Confidential mode admits
 * the actual endpoint and wire model, rejects redirects, and commits metadata
 * before dispatch. Response headers are not proof of completed streaming.
 */
export async function fetchWithConfidentialInference(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	transport: typeof fetch,
): Promise<Response> {
	const scope = attemptScope.getStore();
	if (!scope) return transport(input, init);
	if (typeof input !== "string" && !(input instanceof URL)) {
		return deny(scope, "CONFIDENTIAL_INFERENCE_REQUEST_UNSUPPORTED");
	}
	if (init?.method !== "POST" || typeof init.body !== "string") {
		return deny(scope, "CONFIDENTIAL_INFERENCE_REQUEST_UNSUPPORTED");
	}
	let endpoint: URL;
	let model: string;
	try {
		endpoint = new URL(input);
		const body = JSON.parse(init.body) as { model?: unknown };
		if (typeof body.model !== "string" || body.model.length === 0) {
			throw rejection("CONFIDENTIAL_INFERENCE_REQUEST_UNSUPPORTED");
		}
		model = body.model;
	} catch {
		// error-policy:J3 Invalid wire input never becomes an admitted request.
		return deny(scope, "CONFIDENTIAL_INFERENCE_REQUEST_UNSUPPORTED");
	}
	if (
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		return deny(scope, "CONFIDENTIAL_INFERENCE_ROUTE_DENIED");
	}
	const localHttp =
		endpoint.protocol === "http:" &&
		["127.0.0.1", "[::1]"].includes(endpoint.hostname);
	if (endpoint.protocol !== "https:" && !localHttp) {
		return deny(scope, "CONFIDENTIAL_INFERENCE_ROUTE_DENIED");
	}
	const request = {
		...init,
		headers: new Headers(init.headers),
		body: init.body,
		redirect: "error" as const,
	};
	const profile = await currentProfile(scope);
	const route = profile.routes.find(
		(candidate) =>
			candidate.endpoint === endpoint.href &&
			candidate.model === model &&
			candidate.modelTypes.includes(scope.modelType),
	);
	if (!route)
		return deny(scope, "CONFIDENTIAL_INFERENCE_ROUTE_DENIED", profile);
	let record: ConfidentialInferenceAuditRecord = {
		attemptId: randomUUID(),
		agentId: scope.agentId,
		modelType: scope.modelType,
		policyRevision: profile.revision,
		routeId: route.id,
		timestamp: Date.now(),
		phase: "dispatch_intent",
	};
	let authorized = false;
	let callbackEntered = false;
	const beforeDispatch = async (
		evidence?: ConfidentialInferenceTransportEvidence,
	): Promise<void> => {
		if (callbackEntered)
			throw rejection("CONFIDENTIAL_INFERENCE_TRANSPORT_CONTRACT");
		callbackEntered = true;
		const evidenceDigest = evidence?.evidenceDigest;
		const connectionBindingDigest = evidence?.connectionBindingDigest;
		if (
			scope.authority.transport &&
			(typeof evidenceDigest !== "string" ||
				typeof connectionBindingDigest !== "string" ||
				!/^[0-9a-f]{64}$/.test(evidenceDigest) ||
				!/^[0-9a-f]{64}$/.test(connectionBindingDigest))
		) {
			return deny(
				scope,
				"CONFIDENTIAL_INFERENCE_TRANSPORT_CONTRACT",
				profile,
				record.attemptId,
				route.id,
			);
		}
		if (scope.authority.deniesRedispatch && !scope.operation.authorizeOnce()) {
			return deny(
				scope,
				"CONFIDENTIAL_INFERENCE_REDISPATCH_REQUIRES_RECONCILIATION",
				profile,
				record.attemptId,
				route.id,
			);
		}
		const requireCurrentPolicy = async () => {
			const current = await currentProfile(scope, record);
			if (JSON.stringify(current) !== JSON.stringify(profile)) {
				return deny(
					scope,
					"CONFIDENTIAL_INFERENCE_POLICY_CHANGED",
					profile,
					record.attemptId,
					route.id,
				);
			}
		};
		await requireCurrentPolicy();
		record = {
			...record,
			timestamp: Date.now(),
			...(evidenceDigest && connectionBindingDigest
				? { evidenceDigest, connectionBindingDigest }
				: {}),
		};
		await scope.authority.record(record, false);
		// Audit persistence may race revocation; recheck immediately before egress.
		await requireCurrentPolicy();
		authorized = true;
	};
	let response: Response;
	try {
		if (scope.authority.transport) {
			response = await scope.authority.transport(endpoint.href, request, {
				route,
				policyRevision: profile.revision,
				beforeDispatch,
			});
		} else {
			await beforeDispatch();
			response = await transport(endpoint.href, request);
		}
		if (!authorized) {
			if (response.body) await response.body.cancel();
			return deny(
				scope,
				"CONFIDENTIAL_INFERENCE_TRANSPORT_CONTRACT",
				profile,
				record.attemptId,
				route.id,
			);
		}
	} catch (error) {
		// error-policy:J2 Keep the original transport outcome after mandatory audit.
		if (!authorized) {
			if (
				error instanceof ElizaError &&
				error.code.startsWith("CONFIDENTIAL_INFERENCE_")
			)
				throw error;
			return deny(
				scope,
				"CONFIDENTIAL_INFERENCE_TRANSPORT_REJECTED",
				profile,
				record.attemptId,
				route.id,
			);
		}
		await scope.authority.record(
			{ ...record, timestamp: Date.now(), phase: "transport_error" },
			true,
		);
		throw error;
	}
	try {
		await scope.authority.record(
			{
				...record,
				timestamp: Date.now(),
				phase: "response_headers",
				status: response.status,
			},
			true,
		);
	} catch (error) {
		// error-policy:J2 No successful response escapes without its durable outcome.
		if (response.body) {
			try {
				await response.body.cancel();
			} catch {
				// error-policy:J6 Response teardown failure cannot hide the mandatory audit failure.
				logger.warn(
					"[ConfidentialInference] Failed to cancel an unaudited response body",
				);
			}
		}
		throw error;
	}
	return response;
}
