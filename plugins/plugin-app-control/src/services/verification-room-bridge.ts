/**
 * Relays completed app and plugin verification into the chat room that started
 * the coding task. The bridge waits on the runtime's registered coordinator
 * lifecycle, owns cancellation of its loopback installation requests, and only
 * deduplicates verdicts after the chat memory commits successfully.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
	IAgentRuntime,
	ISwarmCoordinatorService,
	Memory,
	SwarmEvent,
	UUID,
} from "@elizaos/core";
import {
	logger,
	resolveServerOnlyPort,
	Service,
	SWARM_COORDINATOR_SERVICE_TYPE,
} from "@elizaos/core";
import { createViewsRequestHeaders } from "../actions/views-request-auth.js";

export const VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE = "verification-room-bridge";

const APP_VERIFICATION_SERVICE = "app-verification";
const VERIFY_APP_METHOD = "verifyApp";
const VERIFY_PLUGIN_METHOD = "verifyPlugin";

/**
 * Dedupe TTL for verdict events keyed by `${sessionId}:${verdict}`.
 *
 * The broadcast bus may replay events under network blips, supervisor
 * retries, or multi-listener deployments. A real verdict for
 * a given session lands once, within seconds; 10 minutes is well past
 * the window where a duplicate is anything other than a replay.
 */
const VERDICT_DEDUPE_TTL_MS = 10 * 60 * 1000;

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
function decodeEvent(event: SwarmEvent): BridgeEventPayload | null {
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

/**
 * Live-load a freshly built plugin directory into the running runtime via the
 * loopback agent API. Returns the load outcome so the verdict message can tell
 * the user whether the plugin is actually live or just built on disk.
 */
async function loadPluginFromWorkdir(
	workdir: string,
	signal: AbortSignal,
): Promise<{ ok: boolean; pluginName?: string; error?: string }> {
	const port = resolveServerOnlyPort(process.env);
	try {
		const resp = await fetch(
			`http://127.0.0.1:${port}/api/plugins/load-from-directory`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({ directory: workdir }),
				signal,
			},
		);
		let rawBody: unknown;
		try {
			rawBody = await resp.json();
		} catch (error) {
			// error-policy:J3 malformed loopback JSON is an explicit load
			// failure, never a fabricated empty response.
			return {
				ok: false,
				error: `load returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (!isRecord(rawBody)) {
			return { ok: false, error: "load returned a non-object JSON response" };
		}
		const body = rawBody;
		if (resp.ok && body.ok === true) {
			return {
				ok: true,
				pluginName:
					typeof body.pluginName === "string" ? body.pluginName : undefined,
			};
		}
		return {
			ok: false,
			error:
				typeof body.error === "string"
					? body.error
					: `load returned HTTP ${resp.status}`,
		};
	} catch (err) {
		if (signal.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Verification-room bridge stopped during plugin load", {
						cause: err,
					});
		}
		// error-policy:J1 translate the loopback transport boundary into the
		// explicit install-failed verdict shown to the user.
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

interface RegisteredAppItem {
	slug: string;
	canonicalName: string;
}

/**
 * Register a freshly built app into the running runtime via the loopback agent
 * API so a subsequent `launch <name>` resolves. The
 * `/api/apps/load-from-directory` route scans a *parent* directory for app
 * subdirs and registers each valid one through the AppRegistryService
 * (`trust: "external"`), so we pass the workdir's parent, not the workdir
 * itself. That register is idempotent by slug and the worker host returns the
 * existing worker for an already-registered sibling, so re-scanning the shared
 * apps dir does not churn unrelated apps. Returns the registered items so the
 * verdict message can confirm the app is actually launchable instead of
 * promising a `launch` that would fail with "No installed app matches".
 */
async function loadAppFromWorkdir(
	workdir: string,
	signal: AbortSignal,
): Promise<
	{ ok: true; items: RegisteredAppItem[] } | { ok: false; error: string }
> {
	const port = resolveServerOnlyPort(process.env);
	const directory = path.dirname(workdir);
	try {
		const resp = await fetch(
			`http://127.0.0.1:${port}/api/apps/load-from-directory`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({ directory }),
				signal,
			},
		);
		let rawBody: unknown;
		try {
			rawBody = await resp.json();
		} catch (error) {
			// error-policy:J3 malformed loopback JSON is an explicit
			// registration failure, never a fabricated empty response.
			return {
				ok: false,
				error: `register returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (!isRecord(rawBody)) {
			return {
				ok: false,
				error: "register returned a non-object JSON response",
			};
		}
		const body = rawBody;
		if (resp.ok && body.ok === true) {
			const items = Array.isArray(body.items)
				? body.items.filter(
						(item): item is RegisteredAppItem =>
							isRecord(item) &&
							typeof item.slug === "string" &&
							typeof item.canonicalName === "string",
					)
				: [];
			return { ok: true, items };
		}
		return {
			ok: false,
			error:
				typeof body.error === "string"
					? body.error
					: `register returned HTTP ${resp.status}`,
		};
	} catch (err) {
		if (signal.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Verification-room bridge stopped during app load", {
						cause: err,
					});
		}
		// error-policy:J1 translate the loopback transport boundary into the
		// explicit install-failed verdict shown to the user.
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function buildPassMessage(
	payload: BridgeEventPayload,
	signal: AbortSignal,
): Promise<string> {
	const isApp = payload.method === VERIFY_APP_METHOD;
	if (isApp) {
		// Register the freshly built app so `launch <name>` resolves. Without this
		// the app is on disk but absent from the registry + installs, and launch
		// fails with "No installed app matches" (#11954). Only promise the launch
		// once a registered app actually resolves to the name we'd tell the user.
		if (!payload.workdir) {
			return `${payload.targetName} app built and verified, but its build directory is unknown, so it could not be installed. It won't launch until it's registered.`;
		}
		const load = await loadAppFromWorkdir(payload.workdir, signal);
		if (!load.ok) {
			return `${payload.targetName} app built and verified at ${payload.workdir}, but installing it failed: ${load.error}. It won't launch until it's registered — reload the agent or check its package.json manifest.`;
		}
		const target = payload.targetName.toLowerCase();
		const launchable = load.items.some(
			(item) =>
				item.slug.toLowerCase() === target ||
				item.canonicalName.toLowerCase() === target,
		);
		if (launchable) {
			return `${payload.targetName} app built, verified, and installed — reply 'launch ${payload.targetName}' to open it.`;
		}
		// The registry scan succeeded but nothing resolved to the requested name:
		// the built manifest is missing its `elizaos.app` block or registered
		// under a different name. Don't promise a launch that would fail.
		return `${payload.targetName} app built and verified at ${payload.workdir}, but it did not register under a launchable name — reply 'list apps' to see what installed.`;
	}

	// Plugins: attempt to live-load the built source so its views/actions appear
	// without a restart. `reinject` is NOT advertised — it only drops an *ejected*
	// plugin to fall back to the npm copy and cannot load a new local plugin.
	if (payload.workdir) {
		const load = await loadPluginFromWorkdir(payload.workdir, signal);
		if (load.ok) {
			return `${payload.targetName} plugin built, verified, and loaded live — its views and actions are now available.`;
		}
		return `${payload.targetName} plugin built and verified at ${payload.workdir}, but live-load failed: ${load.error}. Reload the agent to pick it up.`;
	}
	return `${payload.targetName} plugin built and verified. Reload the agent to load it.`;
}

function buildFailMessage(payload: BridgeEventPayload): string {
	const retries =
		typeof payload.retryCount === "number"
			? `${payload.retryCount}${typeof payload.maxRetries === "number" ? `/${payload.maxRetries}` : ""}`
			: "the maximum";
	const summary = payload.summary ?? "no further details available";

	// Offer a rollback so the user is never left with a broken create/edit. A
	// pre-edit git snapshot was taken before the coding agent ran (#8915); naming
	// the VIEWS rollback action lets them restore the source in one reply. Apps
	// don't yet take snapshots, so they keep the retry/cancel offer.
	const offer =
		payload.method === VERIFY_PLUGIN_METHOD
			? `Reply 'retry' to keep going, 'rollback' to undo the changes and restore ${payload.targetName} to its pre-edit snapshot (VIEWS action=rollback view=${payload.targetName}), or 'cancel' to stop.`
			: "Reply 'retry' to keep going or 'cancel' to stop.";
	return `${payload.targetName} hit verification failure ${retries} time(s). Last failure: ${summary}. ${offer}`;
}

export class VerificationRoomBridgeService extends Service {
	static override serviceType = VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE;

	override capabilityDescription =
		"Posts the AppVerificationService verdict back into the originating chat room when the orchestrator's custom-validator branch fires task_complete / escalation events.";

	private unsubscribe: (() => void) | null = null;
	private readonly lifecycleAbort = new AbortController();
	private stopped = false;

	/**
	 * Dedupe map: `${sessionId}:${verdict}` -> expiresAt epoch ms. Drops
	 * replayed verdict events after their chat memories commit. In-flight work
	 * is coalesced separately so a failed write remains retryable.
	 */
	private readonly verdictDedupe: Map<string, number> = new Map();
	private readonly verdictsInFlight: Map<string, Promise<void>> = new Map();

	static override async start(
		runtime: IAgentRuntime,
	): Promise<VerificationRoomBridgeService> {
		const service = new VerificationRoomBridgeService(runtime);
		await service.attach();
		return service;
	}

	override async stop(): Promise<void> {
		this.stopped = true;
		this.lifecycleAbort.abort(
			new Error("Verification-room bridge stopped during verdict processing"),
		);
		const unsub = this.unsubscribe;
		// Always clear the field first so a retry of stop() can't double-call.
		this.unsubscribe = null;
		if (unsub !== null) {
			try {
				unsub();
			} catch (err) {
				// error-policy:J6 coordinator unsubscribe is best-effort teardown.
				logger.warn(
					`[VerificationRoomBridge] unsubscribe threw during stop(): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		await Promise.all(this.verdictsInFlight.values());
	}

	private async attach(): Promise<void> {
		// Service definitions are registered before service startup begins.
		// `hasService` therefore distinguishes "orchestrator is not part of this
		// runtime" from "orchestrator is registered and still starting" without
		// a timer, retry count, or arbitrary boot threshold.
		if (!this.runtime.hasService(SWARM_COORDINATOR_SERVICE_TYPE)) {
			logger.debug(
				"[VerificationRoomBridge] SWARM_COORDINATOR is not registered; bridge is inactive",
			);
			return;
		}
		const coordinator = (await this.runtime.getServiceLoadPromise(
			SWARM_COORDINATOR_SERVICE_TYPE,
		)) as Partial<ISwarmCoordinatorService>;
		if (typeof coordinator.subscribe !== "function") {
			throw new TypeError(
				"[VerificationRoomBridge] SWARM_COORDINATOR does not expose subscribe()",
			);
		}
		this.unsubscribe = coordinator.subscribe((event) => {
			void this.handleEvent(event);
		});
		logger.info(
			"[VerificationRoomBridge] subscribed to SWARM_COORDINATOR event stream",
		);
	}

	private async handleEvent(event: SwarmEvent): Promise<void> {
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
		const existing = this.verdictsInFlight.get(dedupeKey);
		if (existing) {
			await existing;
			return;
		}

		const processing = this.processVerdict(payload)
			.then(() => {
				this.verdictDedupe.set(dedupeKey, Date.now() + VERDICT_DEDUPE_TTL_MS);
			})
			.catch((error: unknown) => {
				if (this.stopped && this.lifecycleAbort.signal.aborted) {
					logger.debug(
						"[VerificationRoomBridge] verdict processing cancelled during stop",
					);
					return;
				}
				// error-policy:J7 event failures remain observable without
				// rejecting the coordinator's broadcast loop.
				this.runtime.reportError("VerificationRoomBridge.handleEvent", error, {
					sessionId: event.sessionId,
					verdict: payload.verdict,
					targetName: payload.targetName,
				});
			})
			.finally(() => {
				this.verdictsInFlight.delete(dedupeKey);
			});
		this.verdictsInFlight.set(dedupeKey, processing);
		await processing;
	}

	private async processVerdict(payload: BridgeEventPayload): Promise<void> {
		this.lifecycleAbort.signal.throwIfAborted();
		const text =
			payload.verdict === "pass"
				? await buildPassMessage(payload, this.lifecycleAbort.signal)
				: buildFailMessage(payload);
		this.lifecycleAbort.signal.throwIfAborted();

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
