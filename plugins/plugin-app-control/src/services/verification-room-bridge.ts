/**
 * @module plugin-app-control/services/verification-room-bridge
 *
 * Closes the chat loop for the APP/PLUGIN create flow.
 *
 * The dispatchers in `actions/app-create.ts` and the plugin-manager's
 * `plugin-handlers/create.ts` start a coding agent via START_CODING_TASK and
 * return immediately ("Started task; verification will run when it's
 * done"). The user's chat turn ends. When the AppVerificationService
 * eventually verifies the workdir, the swarm coordinator broadcasts a
 * `task_complete` (verdict=pass) or `escalation` (verdict=fail) event
 * — but no chat surface receives it. This service subscribes to that
 * broadcast stream and posts a continuation message back into the
 * originating room so the user actually sees the verdict.
 *
 * Subscription mechanism: the SwarmCoordinator service exposes
 * `subscribe(listener)` which calls the listener for every event also
 * sent to SSE/WS clients. This service registers on `start()` and
 * unsubscribes on `stop()`.
 *
 * Privacy filter: the privacy filter at
 * `eliza/plugins/app-training/src/core/privacy-filter.ts` exists for
 * trajectory exports — it anonymizes user-content trajectories before
 * disk/cloud writes. Messages this service writes are agent-authored
 * verification results and contain no user trajectory data, so the
 * filter does not apply here.
 *
 * Owner gating: this service only writes to the originRoomId that the
 * dispatcher itself stamped onto the START_CODING_TASK metadata. The
 * dispatcher already enforced `hasOwnerAccess` at request time. The
 * bridge does not bypass any access check — it simply replies in the
 * same room the original create request came from.
 */

import { randomUUID } from "node:crypto";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";

export const VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE = "verification-room-bridge";

const APP_VERIFICATION_SERVICE = "app-verification";
const VERIFY_APP_METHOD = "verifyApp";
const VERIFY_PLUGIN_METHOD = "verifyPlugin";

/**
 * Dedupe TTL for verdict events keyed by `${sessionId}:${verdict}`.
 *
 * The broadcast bus may replay events under network blips, supervisor
 * retries, or a future multi-listener architecture. A real verdict for
 * a given session lands once, within seconds; 10 minutes is well past
 * the window where a duplicate is anything other than a replay.
 */
const VERDICT_DEDUPE_TTL_MS = 10 * 60 * 1000;

/**
 * Minimal shape of the SwarmCoordinator service surface this bridge
 * depends on. We only need `subscribe`; declared locally so we don't
 * pull in plugin-agent-orchestrator as a hard dependency just for
 * types.
 */
interface SwarmEventLike {
	type: string;
	sessionId: string;
	timestamp: number;
	data: unknown;
}

interface SwarmCoordinatorLike {
	subscribe(listener: (event: SwarmEventLike) => void): () => void;
}

interface BridgeEventPayload {
	originRoomId: string;
	verdict: "pass" | "fail";
	method: typeof VERIFY_APP_METHOD | typeof VERIFY_PLUGIN_METHOD;
	targetName: string;
	label: string | undefined;
	workdir: string | undefined;
	summary: string | undefined;
	retryCount: number | undefined;
	maxRetries: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function readNumber(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Decode a SwarmEvent's data payload into a normalized bridge payload, or
 * `null` if the event isn't relevant (wrong validator service, missing
 * originRoomId, missing target name, malformed shape). Returns `null` for
 * non-actionable events — callers ignore those silently.
 */
function decodeEvent(event: SwarmEventLike): BridgeEventPayload | null {
	if (event.type !== "task_complete" && event.type !== "escalation") {
		return null;
	}
	if (!isRecord(event.data)) return null;

	const verification = isRecord(event.data.verification)
		? event.data.verification
		: null;
	if (!verification) return null;
	if (verification.source !== "custom-validator") return null;

	const validator = isRecord(verification.validator)
		? verification.validator
		: null;
	if (!validator || validator.service !== APP_VERIFICATION_SERVICE) return null;
	if (
		validator.method !== VERIFY_APP_METHOD &&
		validator.method !== VERIFY_PLUGIN_METHOD
	) {
		return null;
	}

	// Validator params live on the `verification` payload (sibling of the
	// `validator` descriptor) — that's how swarm-decision-loop.ts emits them.
	const params = isRecord(verification.params) ? verification.params : null;
	if (!params) return null;
	const method = validator.method;
	const targetName =
		method === VERIFY_APP_METHOD
			? readString(params, "appName")
			: readString(params, "pluginName");
	if (!targetName) return null;

	const originRoomId = readString(event.data, "originRoomId");
	if (!originRoomId) return null;

	const verdict = verification.verdict;
	if (verdict !== "pass" && verdict !== "fail") return null;

	return {
		originRoomId,
		verdict,
		method,
		targetName,
		label: readString(event.data, "label"),
		workdir: readString(event.data, "workdir"),
		summary: readString(event.data, "summary"),
		retryCount: readNumber(event.data, "retryCount"),
		maxRetries: readNumber(event.data, "maxRetries"),
	};
}

function buildPassMessage(payload: BridgeEventPayload): string {
	const isApp = payload.method === VERIFY_APP_METHOD;
	const noun = isApp ? "app" : "plugin";
	const action = isApp
		? `Reply 'launch ${payload.targetName}' to open it.`
		: `Reply 'reinject ${payload.targetName}' to load it.`;
	return `${payload.targetName} ${noun} built and verified. ${action}`;
}

function buildFailMessage(payload: BridgeEventPayload): string {
	const retries =
		typeof payload.retryCount === "number"
			? `${payload.retryCount}${typeof payload.maxRetries === "number" ? `/${payload.maxRetries}` : ""}`
			: "the maximum";
	const summary = payload.summary ?? "no further details available";
	const reply = "Reply 'retry' to keep going or 'cancel' to stop.";
	return `${payload.targetName} hit verification failure ${retries} time(s). Last failure: ${summary}. ${reply}`;
}

export class VerificationRoomBridgeService extends Service {
	static override serviceType = VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE;

	override capabilityDescription =
		"Posts the AppVerificationService verdict back into the originating chat room when the orchestrator's custom-validator branch fires task_complete / escalation events.";

	private unsubscribe: (() => void) | null = null;

	/**
	 * Dedupe map: `${sessionId}:${verdict}` -> expiresAt epoch ms. Drops
	 * replayed verdict events that would otherwise post duplicate chat
	 * memories. Entries age out via `VERDICT_DEDUPE_TTL_MS`; we sweep
	 * opportunistically on each insert (single-digit concurrent verdicts
	 * in practice).
	 */
	private readonly verdictDedupe: Map<string, number> = new Map();

	static override async start(
		runtime: IAgentRuntime,
	): Promise<VerificationRoomBridgeService> {
		const service = new VerificationRoomBridgeService(runtime);
		service.attach();
		return service;
	}

	override async stop(): Promise<void> {
		const unsub = this.unsubscribe;
		// Always clear the field first so a retry of stop() can't double-call.
		this.unsubscribe = null;
		if (unsub === null) return;
		if (typeof unsub !== "function") {
			logger.warn(
				"[VerificationRoomBridge] stored unsubscribe was not a function; skipping",
			);
			return;
		}
		// Single-purpose catch: a misbehaving coordinator must not crash
		// service teardown. Translate the failure into a structured warn
		// log and continue.
		try {
			unsub();
		} catch (err) {
			logger.warn(
				`[VerificationRoomBridge] unsubscribe threw during stop(): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private attach(): void {
		const coordinator = this.runtime.getService(
			"SWARM_COORDINATOR",
		) as SwarmCoordinatorLike | null;
		if (!coordinator || typeof coordinator.subscribe !== "function") {
			// Orchestrator plugin isn't loaded or is on an older surface that
			// doesn't expose subscribe(). plugin-app-control still works for
			// non-create flows without the bridge; log at debug since this
			// fires every boot when the orchestrator isn't enabled.
			logger.debug(
				"[VerificationRoomBridge] SWARM_COORDINATOR service has no subscribe(); bridge inactive. Verification verdicts will not be posted back to chat.",
			);
			return;
		}
		this.unsubscribe = coordinator.subscribe((event) => {
			this.handleEvent(event).catch((err) => {
				logger.error(
					`[VerificationRoomBridge] handleEvent failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		});
		logger.info(
			"[VerificationRoomBridge] subscribed to SWARM_COORDINATOR event stream",
		);
	}

	private async handleEvent(event: SwarmEventLike): Promise<void> {
		const payload = decodeEvent(event);
		if (!payload) return;

		const dedupeKey = `${event.sessionId}:${payload.verdict}`;
		const now = Date.now();
		this.sweepExpiredDedupe(now);
		const existingExpiry = this.verdictDedupe.get(dedupeKey);
		if (existingExpiry !== undefined && existingExpiry > now) {
			logger.debug(
				`[VerificationRoomBridge] dedupe drop sessionId=${event.sessionId} verdict=${payload.verdict}`,
			);
			return;
		}
		this.verdictDedupe.set(dedupeKey, now + VERDICT_DEDUPE_TTL_MS);

		const text =
			payload.verdict === "pass"
				? buildPassMessage(payload)
				: buildFailMessage(payload);

		const memory: Memory = {
			id: randomUUID() as UUID,
			entityId: this.runtime.agentId,
			agentId: this.runtime.agentId,
			roomId: payload.originRoomId as UUID,
			createdAt: Date.now(),
			content: {
				text,
				source: "verification-room-bridge",
				// Structured field so UI and downstream consumers can filter by
				// verdict without text-parsing the human-readable message.
				metadata: { verdict: payload.verdict },
			},
		};

		await this.runtime.createMemory(memory, "messages");
		logger.info(
			`[VerificationRoomBridge] posted ${payload.verdict} verdict for ${payload.targetName} into room=${payload.originRoomId}`,
		);
	}

	private sweepExpiredDedupe(now: number): void {
		for (const [key, expiresAt] of this.verdictDedupe) {
			if (expiresAt <= now) this.verdictDedupe.delete(key);
		}
	}
}

export default VerificationRoomBridgeService;
