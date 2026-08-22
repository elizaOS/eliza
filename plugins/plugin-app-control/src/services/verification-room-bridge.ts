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
 * Messages this service writes are agent-authored verification results and
 * contain no user trajectory data.
 *
 * Owner gating: this service only writes to the originRoomId that the
 * dispatcher itself stamped onto the START_CODING_TASK metadata. The
 * dispatcher already enforced `hasOwnerAccess` at request time. The
 * bridge does not bypass any access check — it simply replies in the
 * same room the original create request came from.
 */

import { randomUUID } from "node:crypto";
import type { IAgentRuntime, Memory, SwarmEvent, UUID } from "@elizaos/core";
import {
	getSwarmCoordinatorService,
	logger,
	ModelType,
	runWithTrajectoryPurpose,
	Service,
} from "@elizaos/core";
import { createViewsRequestHeaders } from "../actions/views-request-auth.js";
import { createAppControlClient } from "../client/api.js";
import { getAppControlApiBase } from "../loopback-api.js";
import { openLaunchUrlInBrowserView } from "./browser-view-navigation.js";
import { loadAppFromWorkdir } from "./verification-helpers.js";

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

/**
 * How often we re-check for the SwarmCoordinator service when it was not
 * registered yet during the first `attach()` call. Plugin start ordering
 * is not deterministic, so we retry on a fixed interval until the
 * coordinator shows up or `ATTACH_MAX_RETRIES` is reached.
 *
 * 500ms interval × 60 retries = 30 seconds of patience — long enough to
 * cover slow plugin-loading on cold boots while still bounding the
 * dangling-timer window after `stop()` to 0.5s.
 */
const ATTACH_RETRY_INTERVAL_MS = 500;
// Attempt count at which a still-unbound bridge stops being "plausibly slow"
// and starts logging loudly + backing off. Not a give-up point: the bridge
// retries indefinitely (a heavy boot can register the coordinator well past
// the old 30s window), it just gets coarser and louder past here.
const ATTACH_MAX_RETRIES = 60;
const ATTACH_MAX_RETRY_INTERVAL_MS = 5_000;

interface BridgeEventPayload {
	originRoomId: string;
	originSource: string | undefined;
	openWhenReady: boolean;
	verdict: "pass" | "fail";
	method: typeof VERIFY_APP_METHOD | typeof VERIFY_PLUGIN_METHOD;
	targetName: string;
	label: string | undefined;
	workdir: string | undefined;
	summary: string | undefined;
	retryCount: number | undefined;
	maxRetries: number | undefined;
}

interface VerificationReply {
	fallback: string;
	receipt: {
		verdict: "pass" | "fail";
		targetType: "app" | "plugin";
		targetName: string;
		status: string;
		openedInBrowser?: boolean;
		link?: { label: string; href: string };
		issue?: string;
		nextStep?: string;
	};
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

function readBoolean(record: Record<string, unknown>, key: string): boolean {
	return record[key] === true;
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
		originSource: readString(event.data, "originSource"),
		openWhenReady: readBoolean(event.data, "openWhenReady"),
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

const VIEW_CAPABLE_APP_SOURCES = new Set([
	"app",
	"chat",
	"client_chat",
	"dashboard",
	"user_chat",
]);

function canOpenBrowserView(payload: BridgeEventPayload): boolean {
	return (
		payload.openWhenReady &&
		payload.originSource !== undefined &&
		VIEW_CAPABLE_APP_SOURCES.has(payload.originSource.toLowerCase())
	);
}

/**
 * Live-load a freshly built plugin directory into the running runtime via the
 * loopback agent API. Returns the load outcome so the verdict message can tell
 * the user whether the plugin is actually live or just built on disk.
 */
async function loadPluginFromWorkdir(
	workdir: string,
): Promise<{ ok: boolean; pluginName?: string; error?: string }> {
	try {
		const resp = await fetch(
			`${getAppControlApiBase()}/api/plugins/load-from-directory`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({ directory: workdir }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		const body = (await resp.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
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
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function buildPassMessage(
	payload: BridgeEventPayload,
): Promise<VerificationReply> {
	const isApp = payload.method === VERIFY_APP_METHOD;
	if (isApp) {
		// Register the freshly built app so `launch <name>` resolves. Without this
		// the app is on disk but absent from the registry + installs, and launch
		// fails with "No installed app matches" (#11954). Only promise the launch
		// once a registered app actually resolves to the name we'd tell the user.
		if (!payload.workdir) {
			const issue =
				"Its build directory is unavailable, so it could not be installed or launched.";
			return {
				fallback: `${payload.targetName} app built and verified, but its build directory is unknown, so it could not be installed. It won't launch until it's registered.`,
				receipt: {
					verdict: "pass",
					targetType: "app",
					targetName: payload.targetName,
					status: "built_verified_install_blocked",
					issue,
					nextStep: "Register the app before trying to launch it.",
				},
			};
		}
		const load = await loadAppFromWorkdir(payload.workdir);
		if (!load.ok) {
			const issue = `Installing the verified app failed: ${load.error}.`;
			return {
				fallback: `${payload.targetName} app built and verified at ${payload.workdir}, but installing it failed: ${load.error}. It won't launch until it's registered — reload the agent or check its package.json manifest.`,
				receipt: {
					verdict: "pass",
					targetType: "app",
					targetName: payload.targetName,
					status: "built_verified_install_failed",
					issue,
					nextStep: "Reload the agent or check the app manifest.",
				},
			};
		}
		const target = payload.targetName.toLowerCase();
		const launchable = load.items.find(
			(item) =>
				item.slug.toLowerCase() === target ||
				item.canonicalName.toLowerCase() === target,
		);
		if (launchable) {
			try {
				const launched = await createAppControlClient().launchApp(
					launchable.canonicalName,
				);
				if (launched.launchUrl) {
					const opened = canOpenBrowserView(payload)
						? await openLaunchUrlInBrowserView(launched.launchUrl)
						: false;
					const link = {
						label: `Open ${launched.displayName}`,
						href: launched.launchUrl,
					};
					return {
						fallback: opened
							? `${launched.displayName} is ready — I opened it in Browser. [${link.label}](${link.href})`
							: `${launched.displayName} is ready: [${link.label}](${link.href})`,
						receipt: {
							verdict: "pass",
							targetType: "app",
							targetName: launched.displayName,
							status: "ready",
							openedInBrowser: opened,
							link,
						},
					};
				}
				return {
					fallback: `${payload.targetName} is ready and running.`,
					receipt: {
						verdict: "pass",
						targetType: "app",
						targetName: payload.targetName,
						status: "ready_running",
					},
				};
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return {
					fallback: `${payload.targetName} was built and verified, but I couldn't open it: ${reason}. Reply 'launch ${payload.targetName}' to try again.`,
					receipt: {
						verdict: "pass",
						targetType: "app",
						targetName: payload.targetName,
						status: "built_verified_launch_failed",
						issue: reason,
						nextStep: `Ask me to launch ${payload.targetName} again.`,
					},
				};
			}
		}
		// The registry scan succeeded but nothing resolved to the requested name:
		// the built manifest is missing its `elizaos.app` block or registered
		// under a different name. Don't promise a launch that would fail.
		return {
			fallback: `${payload.targetName} app built and verified at ${payload.workdir}, but it did not register under a launchable name — reply 'list apps' to see what installed.`,
			receipt: {
				verdict: "pass",
				targetType: "app",
				targetName: payload.targetName,
				status: "built_verified_registration_mismatch",
				issue: "The installed app did not register under a launchable name.",
				nextStep: "Ask me to list the installed apps.",
			},
		};
	}

	// Plugins: attempt to live-load the built source so its views/actions appear
	// without a restart. `reinject` is NOT advertised — it only drops an *ejected*
	// plugin to fall back to the npm copy and cannot load a new local plugin.
	if (payload.workdir) {
		const load = await loadPluginFromWorkdir(payload.workdir);
		if (load.ok) {
			return {
				fallback: `${payload.targetName} plugin built, verified, and loaded live — its views and actions are now available.`,
				receipt: {
					verdict: "pass",
					targetType: "plugin",
					targetName: payload.targetName,
					status: "built_verified_loaded",
				},
			};
		}
		return {
			fallback: `${payload.targetName} plugin built and verified at ${payload.workdir}, but live-load failed: ${load.error}. Reload the agent to pick it up.`,
			receipt: {
				verdict: "pass",
				targetType: "plugin",
				targetName: payload.targetName,
				status: "built_verified_load_failed",
				issue: `Live loading failed: ${load.error}.`,
				nextStep: "Reload the agent to load the plugin.",
			},
		};
	}
	return {
		fallback: `${payload.targetName} plugin built and verified. Reload the agent to load it.`,
		receipt: {
			verdict: "pass",
			targetType: "plugin",
			targetName: payload.targetName,
			status: "built_verified_reload_required",
			nextStep: "Reload the agent to load the plugin.",
		},
	};
}

function buildFailMessage(payload: BridgeEventPayload): VerificationReply {
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
	return {
		fallback: `${payload.targetName} hit verification failure ${retries} time(s). Last failure: ${summary}. ${offer}`,
		receipt: {
			verdict: "fail",
			targetType: payload.method === VERIFY_APP_METHOD ? "app" : "plugin",
			targetName: payload.targetName,
			status: "verification_failed",
			issue: summary,
			nextStep: offer,
		},
	};
}

function hasVerificationReplyModel(runtime: IAgentRuntime): boolean {
	if (typeof runtime.useModel !== "function") return false;
	if (typeof runtime.getModel !== "function") return true;
	return Boolean(runtime.getModel(ModelType.TEXT_SMALL));
}

async function renderVerificationReply(
	runtime: IAgentRuntime,
	reply: VerificationReply,
): Promise<string> {
	if (!hasVerificationReplyModel(runtime)) return reply.fallback;

	const voice =
		typeof runtime.character?.system === "string"
			? runtime.character.system.slice(0, 4_000)
			: "Write briefly, naturally, and without filler.";
	const prompt = [
		"Write one short chat reply in the agent's natural voice for this verified app or plugin lifecycle result.",
		"Use only the receipt facts. Do not mention receipts, tools, verification internals, IDs, paths, or this instruction.",
		"State completed work as complete and failures as failures. Never say work is starting or still underway here.",
		"If a link is present, include the exact Markdown link using its label and href. If a next step is present, include it only when useful.",
		"Return only the user-facing reply, with no JSON or code fence.",
		`Agent voice:\n${voice}`,
		`Verified receipt:\n${JSON.stringify(reply.receipt)}`,
	].join("\n\n");

	try {
		const generated = await runWithTrajectoryPurpose(
			"app_verification_reply",
			() => runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
		);
		let text = typeof generated === "string" ? generated.trim() : "";
		text = text
			.replace(/^```(?:markdown|md|text)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
		if (!text) return reply.fallback;
		const link = reply.receipt.link;
		if (link && !text.includes(link.href)) {
			text = `${text} [${link.label}](${link.href})`;
		}
		return text;
	} catch (err) {
		logger.warn(
			`[VerificationRoomBridge] model reply render failed; using factual fallback: ${err instanceof Error ? err.message : String(err)}`,
		);
		return reply.fallback;
	}
}

export class VerificationRoomBridgeService extends Service {
	static override serviceType = VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE;

	override capabilityDescription =
		"Posts the AppVerificationService verdict back into the originating chat room when the orchestrator's custom-validator branch fires task_complete / escalation events.";

	private unsubscribe: (() => void) | null = null;
	private attachRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private attachRetryAttempts = 0;

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
		// Cancel any pending attach retry before tearing down so a late retry
		// can't subscribe to a coordinator after stop() returned.
		if (this.attachRetryTimer) {
			clearTimeout(this.attachRetryTimer);
			this.attachRetryTimer = null;
		}
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
		const coordinator = getSwarmCoordinatorService(this.runtime);
		if (!coordinator) {
			// Orchestrator plugin isn't loaded yet — but plugin start ordering
			// is not deterministic, so the orchestrator may register its
			// SwarmCoordinator after we ran. Retry on a backoff up to
			// `ATTACH_MAX_RETRIES` so the bridge ends up wired whenever the
			// orchestrator IS in the plugin set. After the retry budget
			// expires we give up quietly — `plugin-app-control` still works
			// for non-create flows without the bridge.
			this.scheduleAttachRetry();
			return;
		}
		// Clear any pending retry timer — we succeeded on this pass.
		if (this.attachRetryTimer) {
			clearTimeout(this.attachRetryTimer);
			this.attachRetryTimer = null;
		}
		this.unsubscribe = coordinator.subscribe((event) => {
			this.handleEvent(event).catch((err) => {
				logger.error(
					`[VerificationRoomBridge] handleEvent failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		});
		logger.info(
			`[VerificationRoomBridge] subscribed to SWARM_COORDINATOR event stream${
				this.attachRetryAttempts > 0
					? ` (after ${this.attachRetryAttempts} retr${this.attachRetryAttempts === 1 ? "y" : "ies"})`
					: ""
			}`,
		);
	}

	private scheduleAttachRetry(): void {
		this.attachRetryAttempts += 1;
		// The orchestrator's SWARM_COORDINATOR can take well over the old
		// bounded window to register + bind on a heavy boot. Giving up at a
		// fixed retry count left this bridge permanently inactive (verdicts
		// never posted back) even though the coordinator DID eventually appear.
		// Retry indefinitely with backoff + escalating severity instead: quiet
		// while it's plausibly just slow, loud once it's clearly wrong. If the
		// orchestrator plugin genuinely isn't installed this loop is harmless
		// (coarse steady-state poll), and stop() clears the timer.
		const interval =
			this.attachRetryAttempts < ATTACH_MAX_RETRIES
				? ATTACH_RETRY_INTERVAL_MS
				: Math.min(
						ATTACH_MAX_RETRY_INTERVAL_MS,
						ATTACH_RETRY_INTERVAL_MS *
							2 ** (this.attachRetryAttempts - ATTACH_MAX_RETRIES),
					);
		if (this.attachRetryAttempts === ATTACH_MAX_RETRIES) {
			// First crossing of the "taking too long" threshold — warn once so a
			// stuck bridge is grep-able without spamming a non-orchestrator boot.
			logger.warn(
				`[VerificationRoomBridge] SWARM_COORDINATOR service still has no subscribe() after ${ATTACH_MAX_RETRIES} attempts (~${Math.round(
					(ATTACH_RETRY_INTERVAL_MS * ATTACH_MAX_RETRIES) / 1000,
				)}s); still retrying. If this persists, verification verdicts will not be posted back to chat — check the orchestrator's SwarmCoordinator startup.`,
			);
		}
		this.attachRetryTimer = setTimeout(() => {
			this.attachRetryTimer = null;
			this.attach();
		}, interval);
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
		this.verdictDedupe.set(dedupeKey, now + VERDICT_DEDUPE_TTL_MS);

		const reply =
			payload.verdict === "pass"
				? await buildPassMessage(payload)
				: buildFailMessage(payload);
		const text = await renderVerificationReply(this.runtime, reply);

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

		// Dashboard and connector sends must go through the registered transport:
		// it persists AND broadcasts the proactive message. A raw createMemory is
		// durable but invisible until refresh, which left the live chat hanging on
		// "I'll post the link" even though the link was already in the database.
		if (payload.originSource) {
			try {
				await this.runtime.sendMessageToTarget(
					{
						source: payload.originSource,
						roomId: payload.originRoomId as UUID,
					},
					memory.content,
				);
				logger.info(
					`[VerificationRoomBridge] delivered ${payload.verdict} verdict for ${payload.targetName} through source=${payload.originSource} room=${payload.originRoomId}`,
				);
				return;
			} catch (err) {
				logger.warn(
					`[VerificationRoomBridge] transport delivery failed for source=${payload.originSource}; persisting for refresh fallback: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

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
