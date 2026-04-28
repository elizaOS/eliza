/**
 * @module plugin-app-control/services/verification-room-bridge
 *
 * Closes the chat loop for the APP/PLUGIN create flow.
 *
 * The dispatchers in `actions/app-create.ts` and the plugin-manager's
 * `plugin-handlers/create.ts` start a coding agent via CREATE_TASK and
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
 * `eliza/apps/app-training/src/core/privacy-filter.ts` exists for
 * trajectory exports — it anonymizes user-content trajectories before
 * disk/cloud writes. Messages this service writes are agent-authored
 * verification results and contain no user trajectory data, so the
 * filter does not apply here.
 *
 * Owner gating: this service only writes to the originRoomId that the
 * dispatcher itself stamped onto the CREATE_TASK metadata. The
 * dispatcher already enforced `hasOwnerAccess` at request time. The
 * bridge does not bypass any access check — it simply replies in the
 * same room the original create request came from.
 */

import { randomUUID } from "node:crypto";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";

export const VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE =
	"verification-room-bridge";

const APP_VERIFICATION_SERVICE = "app-verification";
const VERIFY_APP_METHOD = "verifyApp";
const VERIFY_PLUGIN_METHOD = "verifyPlugin";

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

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

	const params = isRecord(validator.params) ? validator.params : null;
	if (!params) return null;
	const targetName =
		validator.method === VERIFY_APP_METHOD
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
		method: validator.method,
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

	static override async start(
		runtime: IAgentRuntime,
	): Promise<VerificationRoomBridgeService> {
		const service = new VerificationRoomBridgeService(runtime);
		service.attach();
		return service;
	}

	override async stop(): Promise<void> {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}

	private attach(): void {
		const coordinator = this.runtime.getService(
			"SWARM_COORDINATOR",
		) as unknown as SwarmCoordinatorLike | null;
		if (!coordinator || typeof coordinator.subscribe !== "function") {
			// Orchestrator plugin isn't loaded or is on an older surface that
			// doesn't expose subscribe(). Log loudly so the operator knows the
			// bridge is inert; don't throw — plugin-app-control still works
			// for non-create flows without the bridge.
			logger.warn(
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
			},
		};

		await this.runtime.createMemory(memory, "messages");
		logger.info(
			`[VerificationRoomBridge] posted ${payload.verdict} verdict for ${payload.targetName} into room=${payload.originRoomId}`,
		);
	}
}

export default VerificationRoomBridgeService;
