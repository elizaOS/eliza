/**
 * HTTP routes for the local-inference / model management feature.
 *
 * Route shape and auth follow the established `*-compat-routes.ts` pattern:
 *   - `handleLocalInferenceCompatRoutes` returns `true` when it handles a
 *     request and `false` to pass through to the next handler.
 *   - Regular reads use `ensureCompatApiAuthorized`.
 *   - Mutating routes (download start/cancel, active switch, uninstall)
 *     use `ensureCompatSensitiveRouteAuthorized`.
 *   - SSE allows `?token=...` as an alternative to the auth header, via
 *     `isStreamAuthorized`.
 */

import type http from "node:http";
import {
	CandidateModelActivationError,
	type KvOffloadMode,
	type LocalInferenceLoadOverrides,
	validateLocalInferenceLoadArgs,
} from "../services/active-model";
import { AssignmentRejectedError } from "../services/assignments";
import { deviceBridge } from "../services/device-bridge";
import { classifyDeviceTier } from "../services/device-tier";
import {
	handlerRegistry,
	toPublicRegistration,
} from "../services/handler-registry";
import { tryGetMemoryArbiter } from "../services/memory-arbiter";
import { snapshotProviders } from "../services/providers";
import { resolveDeviceTier } from "../services/router-handler";
import { assessVoiceModality } from "../services/routing-policy";
import {
	isRoutingPolicy,
	ROUTING_POLICIES,
	readRoutingPreferences,
	setPolicy,
	setPreferredProvider,
} from "../services/routing-preferences";
import { localInferenceService } from "../services/service";
import { readSystemMemory } from "../services/system-memory";
import type { AgentModelSlot } from "../services/types";
import { AGENT_MODEL_SLOTS } from "../services/types";
import {
	type CompatRuntimeState,
	ensureCompatSensitiveRouteAuthorized,
	ensureRouteAuthorized,
	getCompatApiToken,
	getProvidedApiToken,
	readCompatJsonBody,
	sendJsonError as sendJsonErrorResponse,
	sendJson as sendJsonResponse,
	tokenMatches,
} from "./compat-helpers";

function isStreamAuthorized(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	url: URL,
): boolean {
	const expected = getCompatApiToken();
	if (!expected) return true;

	const headerToken = getProvidedApiToken(req);
	const queryToken = url.searchParams.get("token")?.trim();
	if (
		(headerToken && tokenMatches(expected, headerToken)) ||
		(queryToken && tokenMatches(expected, queryToken))
	) {
		return true;
	}

	res.writeHead(401, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Unauthorized" }));
	return false;
}

function writeSseEvent(
	res: http.ServerResponse,
	payload: Record<string, unknown>,
): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function stringBody(
	body: Record<string, unknown> | null,
	key: string,
): string | null {
	if (!body) return null;
	const raw = body[key];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Strict parser for the per-load `overrides` field on
 * `POST /api/local-inference/active`. Returns either a validated
 * `LocalInferenceLoadOverrides` value or a non-null `error` string.
 *
 * The parser is the single boundary where untrusted JSON becomes typed
 * load args — `validateLocalInferenceLoadArgs` re-runs invariant checks
 * after merging with catalog defaults to catch any catalog-side rule
 * we haven't taught the route layer yet.
 */
function parseLocalInferenceLoadOverrides(raw: unknown):
	| { overrides: LocalInferenceLoadOverrides; error: null }
	| {
			overrides: null;
			error: string;
	  } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { overrides: null, error: "overrides must be an object" };
	}
	const record = raw as Record<string, unknown>;
	const out: LocalInferenceLoadOverrides = {};

	if (record.contextSize !== undefined) {
		if (
			typeof record.contextSize !== "number" ||
			!Number.isInteger(record.contextSize) ||
			record.contextSize < 256
		) {
			return {
				overrides: null,
				error: "overrides.contextSize must be an integer >= 256",
			};
		}
		out.contextSize = record.contextSize;
	}
	for (const key of ["cacheTypeK", "cacheTypeV"] as const) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim().length === 0) {
			return {
				overrides: null,
				error: `overrides.${key} must be a non-empty string`,
			};
		}
		out[key] = value.trim().toLowerCase();
	}
	if (record.gpuLayers !== undefined) {
		if (
			typeof record.gpuLayers !== "number" ||
			!Number.isInteger(record.gpuLayers) ||
			record.gpuLayers < 0
		) {
			return {
				overrides: null,
				error: "overrides.gpuLayers must be a non-negative integer",
			};
		}
		out.gpuLayers = record.gpuLayers;
	}
	if (record.kvOffload !== undefined) {
		const value = record.kvOffload;
		if (typeof value === "string") {
			if (value !== "cpu" && value !== "gpu" && value !== "split") {
				return {
					overrides: null,
					error:
						'overrides.kvOffload must be "cpu", "gpu", "split", or { gpuLayers: number }',
				};
			}
			out.kvOffload = value as KvOffloadMode;
		} else if (
			value !== null &&
			typeof value === "object" &&
			typeof (value as { gpuLayers?: unknown }).gpuLayers === "number" &&
			Number.isInteger((value as { gpuLayers: number }).gpuLayers) &&
			(value as { gpuLayers: number }).gpuLayers >= 0
		) {
			out.kvOffload = {
				gpuLayers: (value as { gpuLayers: number }).gpuLayers,
			};
		} else {
			return {
				overrides: null,
				error:
					'overrides.kvOffload must be "cpu", "gpu", "split", or { gpuLayers: number }',
			};
		}
	}
	for (const key of ["flashAttention", "mmap", "mlock"] as const) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			return {
				overrides: null,
				error: `overrides.${key} must be a boolean`,
			};
		}
		out[key] = value;
	}

	// Run the same validation `resolveLocalInferenceLoadArgs` will run. The
	// optimized desktop FFI runtime can honor the elizaOS fork's KV-cache
	// types; unsupported runtimes fail later at the backend capability gate
	// instead of silently loading fp16.
	try {
		validateLocalInferenceLoadArgs(out, { allowFork: true });
	} catch (err) {
		return {
			overrides: null,
			error: err instanceof Error ? err.message : "invalid overrides",
		};
	}
	return { overrides: out, error: null };
}

/**
 * Match POST/DELETE/GET for `/api/local-inference/installed/:id`.
 * Returns the trimmed id or null.
 */
function matchInstalledId(pathname: string): string | null {
	const match = /^\/api\/local-inference\/installed\/([^/]+)$/.exec(pathname);
	return match?.[1] ?? null;
}

export async function handleLocalInferenceCompatRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;

	if (!pathname.startsWith("/api/local-inference/")) return false;

	// ── SSE: download progress stream ───────────────────────────────────
	if (
		method === "GET" &&
		pathname === "/api/local-inference/downloads/stream"
	) {
		if (!isStreamAuthorized(req, res, url)) return true;

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});

		// Send initial snapshot so a freshly-opened stream immediately reflects
		// whatever is in flight.
		writeSseEvent(res, {
			type: "snapshot",
			downloads: localInferenceService.getDownloads(),
			active: localInferenceService.getActive(),
		});

		const unsubscribeDownloads = localInferenceService.subscribeDownloads(
			(event) => {
				writeSseEvent(res, {
					type: event.type,
					job: event.job,
				});
			},
		);
		const unsubscribeActive = localInferenceService.subscribeActive(
			(active) => {
				writeSseEvent(res, {
					type: "active",
					active,
				});
			},
		);

		const heartbeat = setInterval(() => {
			res.write(": heartbeat\n\n");
		}, 15_000);
		if (typeof heartbeat === "object" && "unref" in heartbeat) {
			heartbeat.unref();
		}

		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribeDownloads();
			unsubscribeActive();
		};
		req.on("close", cleanup);
		req.on("aborted", cleanup);
		return true;
	}

	// ── GET: full hub snapshot (catalog + installed + hardware + state) ─
	if (method === "GET" && pathname === "/api/local-inference/hub") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const snapshot = await localInferenceService.snapshot();
			sendJsonResponse(res, 200, snapshot);
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to load hub",
			);
		}
		return true;
	}

	// ── GET: hardware probe only ────────────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/hardware") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const probe = await localInferenceService.getHardware();
			sendJsonResponse(res, 200, probe);
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to probe hardware",
			);
		}
		return true;
	}

	// ── GET: device tier + live memory budget + resident model state ────
	// The single read clients use to decide local-vs-cloud and to render what
	// the memory arbiter currently holds. Memory is the kernel's allocatable
	// estimate (MemAvailable on Linux/Android), not MemFree.
	if (method === "GET" && pathname === "/api/local-inference/device-tier") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const probe = await localInferenceService.getHardware();
			const tier = classifyDeviceTier(probe);
			const sysmem = readSystemMemory();
			const arbiter = tryGetMemoryArbiter();
			const resident = arbiter
				? {
						pressure: arbiter.currentPressureLevel(),
						models: arbiter.residentSnapshot(),
					}
				: null;
			sendJsonResponse(res, 200, {
				tier,
				memory: {
					availableBytes: sysmem.freeBytes,
					totalBytes: sysmem.totalBytes,
				},
				resident,
			});
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to classify device tier",
			);
		}
		return true;
	}

	// ── GET: curated catalog ────────────────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/catalog") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		sendJsonResponse(res, 200, {
			models: localInferenceService.getCatalog(),
		});
		return true;
	}

	// ── GET: installed models ───────────────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/installed") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const models = await localInferenceService.getInstalled();
			sendJsonResponse(res, 200, { models });
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to list installed models",
			);
		}
		return true;
	}

	// ── POST: start download ────────────────────────────────────────────
	// Body: `{ modelId }` for a curated Eliza-1 entry.
	if (method === "POST" && pathname === "/api/local-inference/downloads") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const modelId = stringBody(body, "modelId");
		const rawSpec = body.spec;
		try {
			let job: Awaited<ReturnType<typeof localInferenceService.startDownload>>;
			if (rawSpec) {
				sendJsonErrorResponse(
					res,
					400,
					"Custom model downloads are disabled; choose an Eliza-1 tier.",
				);
				return true;
			} else if (modelId) {
				job = await localInferenceService.startDownload(modelId);
			} else {
				sendJsonErrorResponse(res, 400, "modelId is required");
				return true;
			}
			sendJsonResponse(res, 202, { job });
		} catch (err) {
			sendJsonErrorResponse(
				res,
				400,
				err instanceof Error ? err.message : "Failed to start download",
			);
		}
		return true;
	}

	// ── GET: provider status snapshot ──────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/providers") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const [providers, deviceTier] = await Promise.all([
				snapshotProviders(),
				resolveDeviceTier(),
			]);
			// voiceModality tells the UI whether the local voice stack (Kokoro TTS /
			// local ASR) can run on this device tier. When not viable, a cloud voice
			// is the *configured* default — surfacing the reason here lets the UI
			// explain that instead of the router silently swapping engines (#12253).
			sendJsonResponse(res, 200, {
				providers,
				voiceModality: assessVoiceModality(deviceTier),
			});
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to read providers",
			);
		}
		return true;
	}

	// ── GET: registered model handlers across all providers ────────────
	if (method === "GET" && pathname === "/api/local-inference/routing") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const [prefs, registrations] = await Promise.all([
				readRoutingPreferences(),
				Promise.resolve(handlerRegistry.getAll().map(toPublicRegistration)),
			]);
			sendJsonResponse(res, 200, {
				registrations,
				preferences: prefs,
			});
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to read routing state",
			);
		}
		return true;
	}

	// ── POST: set preferred provider for a slot (manual override) ──────
	if (
		method === "POST" &&
		pathname === "/api/local-inference/routing/preferred"
	) {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const slot = stringBody(body, "slot") as AgentModelSlot | null;
		if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonErrorResponse(
				res,
				400,
				"slot is required and must be a valid AgentModelSlot",
			);
			return true;
		}
		const raw = body.provider;
		const provider =
			raw === null
				? null
				: typeof raw === "string" && raw.trim().length > 0
					? raw.trim()
					: null;
		try {
			const prefs = await setPreferredProvider(slot, provider);
			sendJsonResponse(res, 200, { preferences: prefs });
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error
					? err.message
					: "Failed to write preferred provider",
			);
		}
		return true;
	}

	// ── POST: set routing policy for a slot ─────────────────────────────
	if (method === "POST" && pathname === "/api/local-inference/routing/policy") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const slot = stringBody(body, "slot") as AgentModelSlot | null;
		if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonErrorResponse(
				res,
				400,
				"slot is required and must be a valid AgentModelSlot",
			);
			return true;
		}
		const raw = body.policy;
		const policy = raw === null ? null : isRoutingPolicy(raw) ? raw : null;
		if (raw !== null && policy === null) {
			sendJsonErrorResponse(
				res,
				400,
				`policy must be one of ${ROUTING_POLICIES.join(", ")} or null`,
			);
			return true;
		}
		try {
			const prefs = await setPolicy(slot, policy);
			sendJsonResponse(res, 200, { preferences: prefs });
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to write routing policy",
			);
		}
		return true;
	}

	// ── GET: model-type assignments ─────────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/assignments") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		try {
			const assignments = await localInferenceService.getAssignments();
			sendJsonResponse(res, 200, { assignments });
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to read assignments",
			);
		}
		return true;
	}

	// ── POST: set / clear a model-type assignment ───────────────────────
	if (method === "POST" && pathname === "/api/local-inference/assignments") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const slot = stringBody(body, "slot") as AgentModelSlot | null;
		if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonErrorResponse(
				res,
				400,
				`slot must be one of ${AGENT_MODEL_SLOTS.join(", ")}`,
			);
			return true;
		}
		// modelId can be null to clear the slot
		const rawModelId = body.modelId;
		const modelId =
			rawModelId === null
				? null
				: typeof rawModelId === "string" && rawModelId.trim().length > 0
					? rawModelId.trim()
					: null;
		try {
			const assignments = await localInferenceService.setSlotAssignment(
				slot,
				modelId,
			);
			sendJsonResponse(res, 200, { assignments });
		} catch (err) {
			if (err instanceof AssignmentRejectedError) {
				// Eliza-1-only stack: the only assignable models are the curated
				// tiers. A rejected pick is a typed, user-visible 422 rather than a
				// silent deferred load failure.
				sendJsonErrorResponse(res, 422, err.message, { code: err.code });
				return true;
			}
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to write assignment",
			);
		}
		return true;
	}

	// ── GET: device bridge status (paired mobile device connectivity) ───
	if (method === "GET" && pathname === "/api/local-inference/device") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		sendJsonResponse(res, 200, deviceBridge.status());
		return true;
	}

	// ── SSE: device bridge status stream ────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/device/stream") {
		if (!isStreamAuthorized(req, res, url)) return true;

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});

		writeSseEvent(res, { type: "status", status: deviceBridge.status() });
		const unsubscribe = deviceBridge.subscribeStatus((status) => {
			writeSseEvent(res, { type: "status", status });
		});
		const heartbeat = setInterval(() => {
			res.write(": heartbeat\n\n");
		}, 15_000);
		if (typeof heartbeat === "object" && "unref" in heartbeat) {
			heartbeat.unref();
		}
		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		req.on("close", cleanup);
		req.on("aborted", cleanup);
		return true;
	}

	// ── GET: legacy custom model search (disabled; curated Eliza-1 only) ─
	if (method === "GET" && pathname === "/api/local-inference/hf-search") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		sendJsonResponse(res, 200, {
			models: [],
			disabled: true,
			reason: "custom-model-search-disabled",
		});
		return true;
	}

	// ── DELETE: cancel download ─────────────────────────────────────────
	{
		const match = /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(pathname);
		if (method === "DELETE" && match) {
			if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
			const cancelled = localInferenceService.cancelDownload(match[1] ?? "");
			sendJsonResponse(res, cancelled ? 200 : 404, { cancelled });
			return true;
		}
	}

	// ── GET: active model ───────────────────────────────────────────────
	if (method === "GET" && pathname === "/api/local-inference/active") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		sendJsonResponse(res, 200, localInferenceService.getActive());
		return true;
	}

	// ── POST: switch active model ───────────────────────────────────────
	// Accepts either:
	//   { "modelId": "..." }                           — legacy shape
	//   { "modelId": "...", "overrides": { ... } }    — per-load overrides
	// Overrides honour: contextSize, cacheTypeK, cacheTypeV, gpuLayers,
	// kvOffload, flashAttention, mmap, mlock. Validation is delegated to
	// `validateLocalInferenceLoadArgs` (desktop-only acceptance set by
	// default; AOSP / paired-device callers route through their own
	// adapter and bypass this path).
	if (method === "POST" && pathname === "/api/local-inference/active") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const modelId = stringBody(body, "modelId");
		if (!modelId) {
			sendJsonErrorResponse(res, 400, "modelId is required");
			return true;
		}
		let overrides: LocalInferenceLoadOverrides | undefined;
		if (body.overrides !== undefined && body.overrides !== null) {
			const parsed = parseLocalInferenceLoadOverrides(body.overrides);
			if (parsed.error !== null) {
				sendJsonErrorResponse(res, 400, parsed.error);
				return true;
			}
			overrides = parsed.overrides;
		}
		try {
			const active = await localInferenceService.setActive(
				state.current,
				modelId,
				overrides,
			);
			sendJsonResponse(res, 200, active);
		} catch (err) {
			// #7679: refuse to activate a candidate-only / weights-staged
			// bundle whose manifest reports `evals.textEval.passed=false`.
			// Surface the structured payload (modelId, manifestVersion,
			// failedEvals) verbatim so the UI can render an actionable
			// "this tier isn't ready" message instead of `[unused]` tokens
			// downstream.
			if (err instanceof CandidateModelActivationError) {
				sendJsonResponse(res, 422, {
					error: err.message,
					modelId: err.modelId,
					manifestVersion: err.manifestVersion,
					failedEvals: err.failedEvals,
				});
				return true;
			}
			sendJsonErrorResponse(
				res,
				400,
				err instanceof Error ? err.message : "Failed to set active model",
			);
		}
		return true;
	}

	// ── DELETE: clear active model ──────────────────────────────────────
	if (method === "DELETE" && pathname === "/api/local-inference/active") {
		if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
		try {
			const active = await localInferenceService.clearActive(state.current);
			sendJsonResponse(res, 200, active);
		} catch (err) {
			sendJsonErrorResponse(
				res,
				500,
				err instanceof Error ? err.message : "Failed to unload model",
			);
		}
		return true;
	}

	// ── POST: verify installed model ────────────────────────────────────
	{
		const match = /^\/api\/local-inference\/installed\/([^/]+)\/verify$/.exec(
			pathname,
		);
		if (method === "POST" && match) {
			if (!(await ensureRouteAuthorized(req, res, state))) return true;
			try {
				const result = await localInferenceService.verifyModel(match[1] ?? "");
				sendJsonResponse(res, 200, result);
			} catch (err) {
				sendJsonErrorResponse(
					res,
					404,
					err instanceof Error ? err.message : "Failed to verify model",
				);
			}
			return true;
		}
	}

	// ── DELETE: uninstall model ─────────────────────────────────────────
	{
		const id = matchInstalledId(pathname);
		if (method === "DELETE" && id) {
			if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
			try {
				const result = await localInferenceService.uninstall(id);
				if (result.removed) {
					sendJsonResponse(res, 200, { removed: true });
				} else if (result.reason === "external") {
					sendJsonErrorResponse(
						res,
						409,
						"Model was discovered from another tool; Eliza will not delete files it does not own",
					);
				} else {
					sendJsonErrorResponse(res, 404, "Model not installed");
				}
			} catch (err) {
				sendJsonErrorResponse(
					res,
					500,
					err instanceof Error ? err.message : "Failed to uninstall model",
				);
			}
			return true;
		}
	}

	return false;
}
