/**
 * Server-side voice-profile management routes.
 *
 * Surfaces the available OmniVoice profiles from:
 *   1. The active Eliza-1 bundle's `cache/voice-preset-*.bin` files.
 *   2. The `models/voice/profiles/` catalog directory (build-time profiles).
 *
 * Routes:
 *   GET  /v1/voice/profiles           — list available profiles
 *   POST /v1/voice/profiles/:id/activate  — set the active default profile
 *   DELETE /v1/voice/profiles/:id     — soft-delete (mark inactive in catalog)
 *
 * The active default profile is persisted in the voice profile catalog JSON
 * (`models/voice/profiles/catalog.json`). On model boot, the engine bridge
 * reads this to pick which preset to load as the default.
 *
 * No runtime recording interface is exposed. Profile creation happens at
 * build time via `bun run voice:create-profile`.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import {
	readVoicePresetFile,
	type VoicePresetFile,
} from "./voice-preset-format";

/** Catalog JSON schema version. */
const CATALOG_SCHEMA_VERSION = 1 as const;

/** One entry in `catalog.json`. */
export interface VoiceProfileCatalogEntry {
	/** Profile identifier — matches the `voice-preset-<id>.bin` filename suffix. */
	id: string;
	/** Human-readable display name. */
	displayName: string;
	/** Build-time instruct string (VoiceDesign vocabulary). */
	instruct: string;
	/** Whether this profile is currently active (visible + usable). */
	active: boolean;
	/** ISO timestamp when this entry was created. */
	createdAt: string;
	/** Optional source bundle. */
	sourceBundleId?: string;
	/** Optional sha256 of the source corpus. */
	corpusSha256?: string;
}

export interface VoiceProfileCatalog {
	version: typeof CATALOG_SCHEMA_VERSION;
	/** ID of the profile to load as the default on model boot. */
	defaultProfileId: string;
	profiles: VoiceProfileCatalogEntry[];
}

export interface VoiceProfileRouteOptions {
	/**
	 * Directory that holds `profiles/catalog.json` and the built-in
	 * `manifest.json`. Defaults to `<repo>/models/voice/`.
	 */
	voiceModelsDir?: string;
	/**
	 * Root of the active Eliza-1 bundle. When set, the routes also scan
	 * `<bundleRoot>/cache/voice-preset-*.bin` for bundle-shipped profiles.
	 */
	bundleRoot?: string;
}

const DEFAULT_PROFILE_ID = "sam";

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

function resolveCatalogPath(voiceModelsDir: string): string {
	return path.join(voiceModelsDir, "profiles", "catalog.json");
}

async function readCatalog(
	voiceModelsDir: string,
): Promise<VoiceProfileCatalog> {
	const catalogPath = resolveCatalogPath(voiceModelsDir);
	if (!fs.existsSync(catalogPath)) {
		return {
			version: CATALOG_SCHEMA_VERSION,
			defaultProfileId: DEFAULT_PROFILE_ID,
			profiles: [],
		};
	}
	try {
		const raw = await fsp.readFile(catalogPath, "utf8");
		const parsed = JSON.parse(raw) as VoiceProfileCatalog;
		if (!parsed.profiles) parsed.profiles = [];
		if (!parsed.defaultProfileId) parsed.defaultProfileId = DEFAULT_PROFILE_ID;
		parsed.version = CATALOG_SCHEMA_VERSION;
		return parsed;
	} catch {
		return {
			version: CATALOG_SCHEMA_VERSION,
			defaultProfileId: DEFAULT_PROFILE_ID,
			profiles: [],
		};
	}
}

async function writeCatalog(
	voiceModelsDir: string,
	catalog: VoiceProfileCatalog,
): Promise<void> {
	const catalogPath = resolveCatalogPath(voiceModelsDir);
	await fsp.mkdir(path.dirname(catalogPath), { recursive: true });
	const tmp = `${catalogPath}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(catalog, null, 2), "utf8");
	await fsp.rename(tmp, catalogPath);
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

/** Parse a preset bin and extract the profile metadata we care about. */
function parsePresetMeta(
	presetPath: string,
): Pick<VoicePresetFile, "instruct" | "refText" | "metadata"> | null {
	if (!fs.existsSync(presetPath)) return null;
	try {
		const bytes = fs.readFileSync(presetPath);
		const preset = readVoicePresetFile(new Uint8Array(bytes));
		return {
			instruct: preset.instruct,
			refText: preset.refText,
			metadata: preset.metadata,
		};
	} catch {
		return null;
	}
}

/** Scan `<bundleRoot>/cache/` for `voice-preset-*.bin` files. */
function scanBundleProfiles(
	bundleRoot: string,
): Array<{ id: string; presetPath: string }> {
	const cacheDir = path.join(bundleRoot, "cache");
	if (!fs.existsSync(cacheDir)) return [];
	const PREFIX = "voice-preset-";
	const SUFFIX = ".bin";
	return fs
		.readdirSync(cacheDir)
		.filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
		.map((f) => {
			const id = f.slice(PREFIX.length, f.length - SUFFIX.length);
			return { id, presetPath: path.join(cacheDir, f) };
		});
}

/** Merge bundle-scanned profiles with catalog entries. */
async function listProfiles(
	_voiceModelsDir: string,
	bundleRoot: string | undefined,
	catalog: VoiceProfileCatalog,
): Promise<
	Array<{
		id: string;
		displayName: string;
		instruct: string;
		active: boolean;
		isDefault: boolean;
		source: "bundle" | "catalog";
		createdAt: string;
	}>
> {
	const seenIds = new Set<string>();
	const out: Array<{
		id: string;
		displayName: string;
		instruct: string;
		active: boolean;
		isDefault: boolean;
		source: "bundle" | "catalog";
		createdAt: string;
	}> = [];

	// Bundle-shipped presets take priority.
	if (bundleRoot) {
		for (const { id, presetPath } of scanBundleProfiles(bundleRoot)) {
			seenIds.add(id);
			const meta = parsePresetMeta(presetPath);
			const catalogEntry = catalog.profiles.find((e) => e.id === id);
			const active = catalogEntry ? catalogEntry.active : true;
			out.push({
				id,
				displayName: catalogEntry?.displayName ?? id,
				instruct: catalogEntry?.instruct ?? meta?.instruct ?? "",
				active,
				isDefault: catalog.defaultProfileId === id,
				source: "bundle",
				createdAt: catalogEntry?.createdAt ?? new Date().toISOString(),
			});
		}
	}

	// Catalog-only profiles (not in bundle).
	for (const entry of catalog.profiles) {
		if (seenIds.has(entry.id)) continue;
		out.push({
			id: entry.id,
			displayName: entry.displayName,
			instruct: entry.instruct,
			active: entry.active,
			isDefault: catalog.defaultProfileId === entry.id,
			source: "catalog",
			createdAt: entry.createdAt,
		});
	}

	return out;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function sendError(
	res: http.ServerResponse,
	status: number,
	message: string,
): void {
	sendJson(res, status, { error: message });
}

/**
 * Route handler for all `/v1/voice/profiles*` endpoints.
 *
 * Returns `true` if the request was handled, `false` to pass through.
 */
export async function handleVoiceProfileRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	opts: VoiceProfileRouteOptions,
): Promise<boolean> {
	const method = req.method?.toUpperCase() ?? "GET";
	const rawUrl = req.url ?? "/";
	// Strip query string for routing.
	const pathname = rawUrl.split("?")[0] ?? rawUrl;

	if (!pathname.startsWith("/v1/voice/profiles")) {
		return false;
	}

	const voiceModelsDir =
		opts.voiceModelsDir ??
		path.join(resolveStateDir(process.env), "models", "voice");
	const bundleRoot = opts.bundleRoot;

	// -------------------------------------------------------------------
	// GET /v1/voice/profiles
	// -------------------------------------------------------------------
	if (method === "GET" && pathname === "/v1/voice/profiles") {
		const catalog = await readCatalog(voiceModelsDir);
		const profiles = await listProfiles(voiceModelsDir, bundleRoot, catalog);
		sendJson(res, 200, {
			defaultProfileId: catalog.defaultProfileId,
			profiles,
		});
		return true;
	}

	// -------------------------------------------------------------------
	// POST /v1/voice/profiles/:id/activate
	// -------------------------------------------------------------------
	const activateMatch = /^\/v1\/voice\/profiles\/([^/]+)\/activate$/.exec(
		pathname,
	);
	if (method === "POST" && activateMatch) {
		const profileId = decodeURIComponent(activateMatch[1] ?? "");
		if (!profileId || !/^[A-Za-z0-9._-]+$/.test(profileId)) {
			sendError(res, 400, `Invalid profile id: ${profileId}`);
			return true;
		}

		const catalog = await readCatalog(voiceModelsDir);

		// Accept any profile that exists in the bundle or catalog.
		const profiles = await listProfiles(voiceModelsDir, bundleRoot, catalog);
		const target = profiles.find((p) => p.id === profileId);
		if (!target) {
			sendError(res, 404, `Profile '${profileId}' not found`);
			return true;
		}
		if (!target.active) {
			sendError(res, 409, `Profile '${profileId}' is inactive (soft-deleted)`);
			return true;
		}

		// Update the catalog default.
		const prevDefault = catalog.defaultProfileId;
		catalog.defaultProfileId = profileId;

		// Ensure the profile has a catalog entry (for bundle-only profiles, create one).
		const existingEntry = catalog.profiles.find((e) => e.id === profileId);
		if (!existingEntry) {
			catalog.profiles.push({
				id: profileId,
				displayName: target.displayName,
				instruct: target.instruct,
				active: true,
				createdAt: new Date().toISOString(),
			});
		}

		await writeCatalog(voiceModelsDir, catalog);

		sendJson(res, 200, {
			defaultProfileId: profileId,
			previousDefaultProfileId: prevDefault,
		});
		return true;
	}

	// -------------------------------------------------------------------
	// DELETE /v1/voice/profiles/:id
	// -------------------------------------------------------------------
	const deleteMatch = /^\/v1\/voice\/profiles\/([^/]+)$/.exec(pathname);
	if (method === "DELETE" && deleteMatch) {
		const profileId = decodeURIComponent(deleteMatch[1] ?? "");
		if (!profileId || !/^[A-Za-z0-9._-]+$/.test(profileId)) {
			sendError(res, 400, `Invalid profile id: ${profileId}`);
			return true;
		}

		const catalog = await readCatalog(voiceModelsDir);

		if (catalog.defaultProfileId === profileId) {
			sendError(
				res,
				409,
				`Cannot delete the active default profile '${profileId}'. Activate a different profile first.`,
			);
			return true;
		}

		// Soft-delete: mark inactive in catalog. Never unlinks shipped bundle files.
		const existingEntry = catalog.profiles.find((e) => e.id === profileId);
		if (existingEntry) {
			existingEntry.active = false;
		} else {
			// Profile exists in bundle but not yet in catalog — add as inactive.
			const profiles = await listProfiles(voiceModelsDir, bundleRoot, catalog);
			const target = profiles.find((p) => p.id === profileId);
			if (!target) {
				sendError(res, 404, `Profile '${profileId}' not found`);
				return true;
			}
			catalog.profiles.push({
				id: profileId,
				displayName: target.displayName,
				instruct: target.instruct,
				active: false,
				createdAt: new Date().toISOString(),
			});
		}

		await writeCatalog(voiceModelsDir, catalog);
		sendJson(res, 200, { deleted: profileId, active: false });
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Server-side default profile loading
// ---------------------------------------------------------------------------

/**
 * Resolve the active default profile id from the voice catalog.
 *
 * Called at model boot (before `EngineVoiceBridge.start()`) to determine
 * which `voice-preset-<id>.bin` to load as the default voice. Returns
 * `"default"` when the catalog has no explicit default set.
 */
export async function resolveDefaultProfileId(
	voiceModelsDir: string,
): Promise<string> {
	const catalog = await readCatalog(voiceModelsDir);
	return catalog.defaultProfileId || DEFAULT_PROFILE_ID;
}

/**
 * Persist a newly created profile into the voice catalog.
 *
 * Called by `bun run voice:create-profile` after the freeze pipeline
 * writes the preset binary. Appends an entry to `catalog.json` if the
 * profile id is not already there; updates instruct + displayName if it is.
 */
export async function registerProfileInCatalog(
	voiceModelsDir: string,
	entry: Omit<VoiceProfileCatalogEntry, "active"> & { active?: boolean },
): Promise<void> {
	const catalog = await readCatalog(voiceModelsDir);
	const existing = catalog.profiles.findIndex((e) => e.id === entry.id);
	const full: VoiceProfileCatalogEntry = {
		...entry,
		active: entry.active ?? true,
	};
	if (existing >= 0) {
		catalog.profiles[existing] = full;
	} else {
		catalog.profiles.push(full);
	}
	await writeCatalog(voiceModelsDir, catalog);
}
