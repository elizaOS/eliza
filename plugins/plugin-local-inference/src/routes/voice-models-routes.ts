/**
 * Local-runtime compat routes for the voice sub-model auto-updater
 * (R5-versioning §3 + §4 + §5).
 *
 * Mirrors the signed Cloud catalog endpoint
 * (`cloud/apps/api/v1/voice-models/catalog/route.ts`) for the on-device
 * surface so the UI can talk to the local runtime without depending on
 * Cloud being reachable. The endpoints expose:
 *
 *   GET  /api/local-inference/voice-models
 *     → { installations: VoiceModelInstallationView[] }
 *     Resolves currently-installed versions by reading the bundle voice
 *     directory (`<state-dir>/models/voice/`) and matching filenames
 *     against `VOICE_MODEL_VERSIONS`.
 *
 *   GET  /api/local-inference/voice-models/check
 *     → { lastCheckedAt, statuses: VoiceModelStatus[] }
 *     Invokes `VoiceModelUpdater.check()` which walks the cascade
 *     (Cloud → GitHub → HF) and returns a per-id decision.
 *
 *   POST /api/local-inference/voice-models/:id/update
 *     → { ok: true, finalPath, sha256, sizeBytes }
 *     Triggers `downloadVoiceModel()` for the named id, gated on
 *     `NetworkPolicy` evaluation per R5 §4. Refuses when the policy
 *     decision is not `allow=true`.
 *
 *   POST /api/local-inference/voice-models/:id/pin
 *     Body: { pinned: boolean }
 *     → { ok: true, id, pinned }
 *     Toggles the on-disk pin file so the auto-updater skips this id.
 *
 *   GET  /api/local-inference/voice-models/preferences
 *     → { preferences: NetworkPolicyPreferences, isOwner: boolean }
 *
 *   POST /api/local-inference/voice-models/preferences
 *     Body: Partial<NetworkPolicyPreferences>
 *     → { ok: true, preferences }
 *     Writes the user's Wi-Fi/cellular/metered policy preferences.
 *     Per R5 §5.4 the cellular + metered toggles are OWNER-only — the
 *     route returns 403 if a non-OWNER caller tries to flip them.
 *
 * Preferences land at
 * `<state-dir>/local-inference/voice-update-prefs.json`; the pin set is
 * stored as a sibling `voice-update-pins.json`.
 */

import fsp from "node:fs/promises";
import type * as http from "node:http";
import path from "node:path";
import {
	logger,
	resolveStateDir,
	sendJson,
	sendJsonError,
} from "@elizaos/core";
import {
	DEFAULT_NETWORK_POLICY_PREFERENCES,
	type NetworkPolicyPreferences,
	type VoiceModelId,
	VOICE_MODEL_VERSIONS,
	type VoiceModelVersion,
} from "@elizaos/shared";
import { evaluateRuntimePolicy } from "../services/network-policy";
import {
	downloadVoiceModel,
	VoiceModelDownloadError,
	VoiceModelUpdater,
	type VoiceModelStatus,
} from "../services/voice-model-updater";
import { readCompatJsonBody } from "./compat-helpers";

const ROUTE_PREFIX = "/api/local-inference/voice-models";

/** All known voice model ids (used to validate path params). */
const KNOWN_VOICE_MODEL_IDS: ReadonlySet<string> = new Set(
	VOICE_MODEL_VERSIONS.map((v) => v.id),
);

export interface VoiceModelInstallationView {
	readonly id: VoiceModelId;
	readonly installedVersion: string | null;
	readonly pinned: boolean;
	readonly lastError: string | null;
}

interface PreferencesFile {
	autoUpdateOnWifi: boolean;
	autoUpdateOnCellular: boolean;
	autoUpdateOnMetered: boolean;
	quietHours: Array<{ start: string; end: string }>;
}

interface PinsFile {
	pinned: VoiceModelId[];
}

/* ----------------------------------------------------------------- *
 * Owner gate — the cellular + metered toggles are OWNER-only.        *
 * The runtime writes `ELIZA_ADMIN_ENTITY_ID` after voice-onboarding  *
 * completes (see voice-onboarding-routes.ts §POST /complete).        *
 * ----------------------------------------------------------------- */

/**
 * `isOwnerRequest()` strategy:
 *
 * 1. If `ELIZA_ADMIN_ENTITY_ID` is unset, no OWNER exists yet — return
 *    `false` (gate stays locked). This is the safe default during first
 *    boot before voice onboarding completes.
 * 2. If the request carries `X-Eliza-Entity-Id` (set by the UI shell for
 *    authenticated sessions), compare against the admin id. Equality
 *    matches case-insensitively because entity ids are UUIDv4.
 * 3. Otherwise return `false`. The UI surfaces the toggle as
 *    "Owner only" rather than throwing — the route still 403s on a
 *    POST that tries to flip a locked toggle.
 */
function isOwnerRequest(req: http.IncomingMessage): boolean {
	const adminId = process.env.ELIZA_ADMIN_ENTITY_ID?.trim();
	if (!adminId) return false;
	const header = req.headers["x-eliza-entity-id"];
	const value = typeof header === "string" ? header.trim() : null;
	if (!value) return false;
	return value.toLowerCase() === adminId.toLowerCase();
}

/* ----------------------------------------------------------------- *
 * State-dir helpers — pure I/O around the prefs + pins files.        *
 * ----------------------------------------------------------------- */

function voicePrefsDir(): string {
	return path.join(resolveStateDir(process.env), "local-inference");
}
function voicePrefsPath(): string {
	return path.join(voicePrefsDir(), "voice-update-prefs.json");
}
function voicePinsPath(): string {
	return path.join(voicePrefsDir(), "voice-update-pins.json");
}
function bundleVoiceDir(): string {
	return path.join(resolveStateDir(process.env), "models", "voice");
}
function voiceStagingDir(): string {
	return path.join(resolveStateDir(process.env), "cache", "voice-staging");
}

async function readPreferences(): Promise<NetworkPolicyPreferences> {
	try {
		const raw = await fsp.readFile(voicePrefsPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<PreferencesFile>;
		return normalizePrefs(parsed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return DEFAULT_NETWORK_POLICY_PREFERENCES;
		}
		logger.warn(
			{ err },
			"[voice-models-routes] failed to read voice-update-prefs.json — using defaults",
		);
		return DEFAULT_NETWORK_POLICY_PREFERENCES;
	}
}

async function writePreferences(prefs: NetworkPolicyPreferences): Promise<void> {
	await fsp.mkdir(voicePrefsDir(), { recursive: true });
	const out: PreferencesFile = {
		autoUpdateOnWifi: prefs.autoUpdateOnWifi,
		autoUpdateOnCellular: prefs.autoUpdateOnCellular,
		autoUpdateOnMetered: prefs.autoUpdateOnMetered,
		quietHours: prefs.quietHours.map((q) => ({ start: q.start, end: q.end })),
	};
	await fsp.writeFile(voicePrefsPath(), JSON.stringify(out, null, 2), "utf8");
}

function normalizePrefs(
	candidate: Partial<PreferencesFile> | null | undefined,
): NetworkPolicyPreferences {
	const def = DEFAULT_NETWORK_POLICY_PREFERENCES;
	if (!candidate || typeof candidate !== "object") return def;
	const quietHours = Array.isArray(candidate.quietHours)
		? candidate.quietHours
				.filter(
					(q): q is { start: string; end: string } =>
						!!q &&
						typeof q === "object" &&
						typeof (q as { start: unknown }).start === "string" &&
						typeof (q as { end: unknown }).end === "string",
				)
				.map((q) => ({ start: q.start, end: q.end }))
		: def.quietHours;
	return {
		autoUpdateOnWifi:
			typeof candidate.autoUpdateOnWifi === "boolean"
				? candidate.autoUpdateOnWifi
				: def.autoUpdateOnWifi,
		autoUpdateOnCellular:
			typeof candidate.autoUpdateOnCellular === "boolean"
				? candidate.autoUpdateOnCellular
				: def.autoUpdateOnCellular,
		autoUpdateOnMetered:
			typeof candidate.autoUpdateOnMetered === "boolean"
				? candidate.autoUpdateOnMetered
				: def.autoUpdateOnMetered,
		quietHours,
	};
}

async function readPins(): Promise<Set<VoiceModelId>> {
	try {
		const raw = await fsp.readFile(voicePinsPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<PinsFile>;
		if (!Array.isArray(parsed.pinned)) return new Set();
		return new Set(
			parsed.pinned.filter((id): id is VoiceModelId =>
				KNOWN_VOICE_MODEL_IDS.has(id),
			),
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		logger.warn(
			{ err },
			"[voice-models-routes] failed to read voice-update-pins.json — treating as empty",
		);
		return new Set();
	}
}

async function writePins(pins: ReadonlySet<VoiceModelId>): Promise<void> {
	await fsp.mkdir(voicePrefsDir(), { recursive: true });
	const out: PinsFile = { pinned: Array.from(pins).sort() };
	await fsp.writeFile(voicePinsPath(), JSON.stringify(out, null, 2), "utf8");
}

/* ----------------------------------------------------------------- *
 * Installed-version resolution                                       *
 * Filenames written by `downloadVoiceModel` follow the pattern        *
 *   `<id>-<version>-<original-asset-name>`                            *
 * so we can recover `installedVersion` by directory listing.          *
 * ----------------------------------------------------------------- */

const INSTALLED_FILENAME_RE = /^([a-z0-9-]+)-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)-/;

export async function resolveInstalledVersions(
	dir: string = bundleVoiceDir(),
): Promise<Map<VoiceModelId, string>> {
	const installed = new Map<VoiceModelId, string>();
	let entries: string[];
	try {
		entries = await fsp.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return installed;
		throw err;
	}
	for (const entry of entries) {
		const m = INSTALLED_FILENAME_RE.exec(entry);
		if (!m) continue;
		const id = m[1] as VoiceModelId;
		const version = m[2] as string;
		if (!KNOWN_VOICE_MODEL_IDS.has(id)) continue;
		const prior = installed.get(id);
		if (!prior || prior < version) installed.set(id, version);
	}
	return installed;
}

/* ----------------------------------------------------------------- *
 * Updater dependency-injection hook (tests stub the updater).        *
 * ----------------------------------------------------------------- */

let updaterOverride: VoiceModelUpdater | null = null;

export function setVoiceModelsUpdater(updater: VoiceModelUpdater | null): void {
	updaterOverride = updater;
}

function getUpdater(): VoiceModelUpdater {
	if (updaterOverride) return updaterOverride;
	return new VoiceModelUpdater({});
}

/* ----------------------------------------------------------------- *
 * Download dependency-injection hook (tests stub the downloader to    *
 * avoid touching the network).                                        *
 * ----------------------------------------------------------------- */

type DownloadFn = typeof downloadVoiceModel;
let downloadOverride: DownloadFn | null = null;

export function setVoiceModelDownloader(fn: DownloadFn | null): void {
	downloadOverride = fn;
}

function getDownloader(): DownloadFn {
	return downloadOverride ?? downloadVoiceModel;
}

/* ----------------------------------------------------------------- *
 * Bundle-version override (tests pass a deterministic bundle version  *
 * so the updater's decision rule is reproducible).                    *
 * ----------------------------------------------------------------- */

let bundleVersionOverride: string | null = null;
export function setVoiceModelsBundleVersionForTest(
	bundleVersion: string | null,
): void {
	bundleVersionOverride = bundleVersion;
}

function resolveBundleVersion(): string {
	if (bundleVersionOverride !== null) return bundleVersionOverride;
	return process.env.ELIZA_BUNDLE_VERSION?.trim() ?? "0.0.0";
}

/* ----------------------------------------------------------------- *
 * Route handler                                                       *
 * ----------------------------------------------------------------- */

export async function handleVoiceModelsRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;
	if (!pathname.startsWith(ROUTE_PREFIX)) return false;

	// GET /api/local-inference/voice-models
	if (method === "GET" && pathname === ROUTE_PREFIX) {
		const [installed, pins] = await Promise.all([
			resolveInstalledVersions(),
			readPins(),
		]);
		const ids = new Set<VoiceModelId>([
			...VOICE_MODEL_VERSIONS.map((v) => v.id),
			...installed.keys(),
		]);
		const installations: VoiceModelInstallationView[] = Array.from(ids)
			.sort()
			.map((id) => ({
				id,
				installedVersion: installed.get(id) ?? null,
				pinned: pins.has(id),
				lastError: null,
			}));
		sendJson(res, { installations });
		return true;
	}

	// GET /api/local-inference/voice-models/check
	if (method === "GET" && pathname === `${ROUTE_PREFIX}/check`) {
		const [installed, pins] = await Promise.all([
			resolveInstalledVersions(),
			readPins(),
		]);
		const updater = getUpdater();
		let statuses: ReadonlyArray<VoiceModelStatus>;
		try {
			statuses = await updater.check(
				{ installed, bundleVersion: resolveBundleVersion() },
				{ pinned: pins },
				{ force: url.searchParams.get("force") === "1" },
			);
		} catch (err) {
			logger.warn(
				{ err },
				"[voice-models-routes] updater.check failed — surfacing as 502",
			);
			sendJsonError(
				res,
				err instanceof Error ? err.message : "updater check failed",
				502,
			);
			return true;
		}
		sendJson(res, {
			lastCheckedAt: new Date().toISOString(),
			statuses: statuses.map(serializeStatus),
		});
		return true;
	}

	// GET /api/local-inference/voice-models/preferences
	if (method === "GET" && pathname === `${ROUTE_PREFIX}/preferences`) {
		const preferences = await readPreferences();
		sendJson(res, { preferences, isOwner: isOwnerRequest(req) });
		return true;
	}

	// POST /api/local-inference/voice-models/preferences
	if (method === "POST" && pathname === `${ROUTE_PREFIX}/preferences`) {
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const owner = isOwnerRequest(req);
		const current = await readPreferences();
		// Build the candidate by overlaying provided fields onto current.
		const candidate = normalizePrefs({
			autoUpdateOnWifi:
				typeof body.autoUpdateOnWifi === "boolean"
					? body.autoUpdateOnWifi
					: current.autoUpdateOnWifi,
			autoUpdateOnCellular:
				typeof body.autoUpdateOnCellular === "boolean"
					? body.autoUpdateOnCellular
					: current.autoUpdateOnCellular,
			autoUpdateOnMetered:
				typeof body.autoUpdateOnMetered === "boolean"
					? body.autoUpdateOnMetered
					: current.autoUpdateOnMetered,
			quietHours: Array.isArray(body.quietHours)
				? (body.quietHours as Array<{ start: string; end: string }>)
				: current.quietHours.map((q) => ({ start: q.start, end: q.end })),
		});
		// OWNER gate: only the OWNER can flip cellular or metered to true.
		if (
			!owner &&
			(candidate.autoUpdateOnCellular !== current.autoUpdateOnCellular ||
				candidate.autoUpdateOnMetered !== current.autoUpdateOnMetered)
		) {
			sendJsonError(
				res,
				"cellular + metered auto-update toggles are owner-only",
				403,
			);
			return true;
		}
		await writePreferences(candidate);
		sendJson(res, { ok: true, preferences: candidate });
		return true;
	}

	// POST /api/local-inference/voice-models/:id/update | :id/pin
	const idActionMatch =
		method === "POST"
			? /^\/api\/local-inference\/voice-models\/([^/]+)\/(update|pin)$/.exec(
					pathname,
				)
			: null;
	if (idActionMatch) {
		const rawId = decodeURIComponent(idActionMatch[1] ?? "");
		const action = idActionMatch[2] as "update" | "pin";
		if (!KNOWN_VOICE_MODEL_IDS.has(rawId)) {
			sendJsonError(res, `unknown voice model id: ${rawId}`, 404);
			return true;
		}
		const id = rawId as VoiceModelId;
		if (action === "pin") {
			const body = await readCompatJsonBody(req, res);
			if (!body) return true;
			const pinned = body.pinned === true;
			const pins = await readPins();
			if (pinned) pins.add(id);
			else pins.delete(id);
			await writePins(pins);
			sendJson(res, { ok: true, id, pinned });
			return true;
		}
		// action === "update"
		const updater = getUpdater();
		const [installed, pins] = await Promise.all([
			resolveInstalledVersions(),
			readPins(),
		]);
		let statuses: ReadonlyArray<VoiceModelStatus>;
		try {
			statuses = await updater.check(
				{ installed, bundleVersion: resolveBundleVersion() },
				{ pinned: pins },
				{ force: true },
			);
		} catch (err) {
			sendJsonError(
				res,
				err instanceof Error ? err.message : "updater check failed",
				502,
			);
			return true;
		}
		const status = statuses.find((s) => s.id === id);
		if (!status?.latestKnown) {
			sendJsonError(res, `no candidate version for ${id}`, 404);
			return true;
		}
		// R5 §4 — gate the download on the network policy decision.
		const prefs = await readPreferences();
		const totalBytes = status.latestKnown.ggufAssets.reduce(
			(sum, a) => sum + a.sizeBytes,
			0,
		);
		const networkPolicy = await evaluateRuntimePolicy({
			prefs,
			estimatedBytes: totalBytes,
		});
		if (!networkPolicy.allow) {
			sendJsonError(
				res,
				`network policy refused (reason=${networkPolicy.reason})`,
				409,
			);
			return true;
		}
		// First asset only — multi-asset downloads are a future iteration.
		if (status.latestKnown.ggufAssets.length === 0) {
			sendJsonError(res, `no assets published for ${id}`, 409);
			return true;
		}
		const controller = new AbortController();
		try {
			const result = await getDownloader()({
				version: status.latestKnown,
				bundleVoiceDir: bundleVoiceDir(),
				stagingDir: voiceStagingDir(),
				assetIndex: 0,
				networkPolicy,
				signal: controller.signal,
			});
			sendJson(res, {
				ok: true,
				id,
				version: status.latestKnown.version,
				finalPath: result.finalPath,
				sha256: result.sha256,
				sizeBytes: result.sizeBytes,
			});
		} catch (err) {
			if (err instanceof VoiceModelDownloadError) {
				sendJsonError(res, err.message, 502);
				return true;
			}
			throw err;
		}
		return true;
	}

	return false;
}

function serializeStatus(s: VoiceModelStatus): {
	id: VoiceModelId;
	installedVersion: string | null;
	pinned: boolean;
	latestKnown: VoiceModelVersion | null;
	allow: boolean;
	reason: VoiceModelStatus["decision"]["reason"];
} {
	return {
		id: s.id,
		installedVersion: s.installedVersion,
		pinned: s.pinned,
		latestKnown: s.latestKnown,
		allow: s.decision.allow,
		reason: s.decision.reason,
	};
}
