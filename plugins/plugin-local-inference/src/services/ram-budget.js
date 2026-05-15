/**
 * Resolve a model's RAM budget and decide whether it fits the host.
 *
 * For installed Eliza-1 tiers WITH a published `eliza-1.manifest.json`
 * on disk we prefer the manifest's `ramBudgetMb.{min, recommended}`
 * block — that's what packages/inference/AGENTS.md §3 + §6 designate
 * as the source of truth for per-bundle memory expectations. For every
 * other model (non-Eliza-1, uninstalled tiers, or Eliza-1 bundles that
 * predate the manifest publish) we fall back to the catalog scalar
 * `model.minRamGb` for the floor and synthesize a `recommendedMb` from
 * the floor plus the bundle's per-token KV-cache footprint at its default
 * context window — the same `KvGeometry` figure `kv-spill.ts` uses. That
 * fixes the degenerate `minMb == recommendedMb` catalog case: a long
 * session grows into the KV cache, so "boots" and "runs comfortably" are
 * genuinely different lines.
 *
 * The manifest read is best-effort: a missing or malformed manifest
 * never throws — recommendation runs at runtime and a broken manifest
 * must not crash the dashboard. Build-time gates live in the publish
 * script (packages/training/scripts/manifest/eliza1_manifest.py) and
 * the validator (`./manifest/validator.ts`).
 *
 * This module is the single source of truth for the "does model X fit a
 * host with N MB usable RAM" decision (`assessRamFit`). Both the Model
 * Hub recommender (`recommendation.ts`) and the model-load admission gate
 * (`active-model.ts`) call it — neither re-derives the math.
 */
import fs from "node:fs";
import path from "node:path";
import { ELIZA_1_TIER_IDS, MODEL_CATALOG } from "./catalog";
import { estimateQuantizedKvBytesPerToken } from "./kv-spill";
import { validateManifest } from "./manifest";

const MB_PER_GB = 1024;
const BYTES_PER_MB = 1024 * 1024;
/**
 * RAM kept free for the OS, the dashboard, connectors, and the runtime
 * itself when deciding whether a model load fits. The model's resident
 * weights + KV cache must fit inside `(hostRamMb - RAM_HEADROOM_RESERVE_MB)`.
 * Override via `ELIZA_LOCAL_RAM_HEADROOM_MB`.
 */
const DEFAULT_RAM_HEADROOM_RESERVE_MB = 1536;
/**
 * Default context window assumed for a catalog entry that doesn't declare
 * `contextLength`. Used only to size the synthesized `recommendedMb` KV
 * component; conservative on purpose.
 */
const FALLBACK_DEFAULT_CONTEXT_TOKENS = 32768;
export function ramHeadroomReserveMb() {
	const raw = process.env.ELIZA_LOCAL_RAM_HEADROOM_MB?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_RAM_HEADROOM_RESERVE_MB;
}
const ELIZA_1_TIER_ID_SET = new Set(ELIZA_1_TIER_IDS);
function isEliza1TierId(id) {
	return ELIZA_1_TIER_ID_SET.has(id);
}
function manifestTierFromId(id) {
	// Catalog id `eliza-1-<tier>` → manifest tier `<tier>`.
	return id.slice("eliza-1-".length);
}
/**
 * Production manifest loader — reads `eliza-1.manifest.json` from the
 * installed bundle's directory. Two candidate paths are probed:
 *
 *   1. `dirname(dirname(model.path))` — the canonical bundle root when
 *      the GGUF lives in a `text/` subdir per AGENTS.md §2.
 *   2. `dirname(model.path)` — flat layout used by some test fixtures
 *      and pre-bundle installs.
 *
 * Returns `null` for any failure: missing file, JSON parse error,
 * manifest validation error, or tier mismatch.
 */
export function defaultManifestLoader(modelId, installed) {
	if (!installed?.path) return null;
	if (!isEliza1TierId(modelId)) return null;
	const expectedTier = manifestTierFromId(modelId);
	const candidates = [
		path.join(
			path.dirname(path.dirname(installed.path)),
			"eliza-1.manifest.json",
		),
		path.join(path.dirname(installed.path), "eliza-1.manifest.json"),
	];
	for (const candidate of candidates) {
		let raw;
		try {
			raw = fs.readFileSync(candidate, "utf8");
		} catch {
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const result = validateManifest(parsed);
		if (!result.ok) continue;
		if (result.manifest.tier !== expectedTier) continue;
		return result.manifest;
	}
	return null;
}
/**
 * Synthesized `recommendedMb` for the catalog fallback: the floor plus the
 * bundle's compressed KV-cache footprint at its default context window.
 * That's the figure a nominal long-running session actually grows into —
 * a far better "fits vs tight" cutoff than reusing the floor verbatim.
 */
function catalogRecommendedMb(model, minMb) {
	const ctxTokens =
		typeof model.contextLength === "number" && model.contextLength > 0
			? model.contextLength
			: FALLBACK_DEFAULT_CONTEXT_TOKENS;
	const kvBytes = estimateQuantizedKvBytesPerToken(model.params) * ctxTokens;
	const kvMb = Math.ceil(kvBytes / BYTES_PER_MB);
	return minMb + kvMb;
}
/**
 * Resolve a `RamBudget` for `model`, optionally consulting the on-disk
 * manifest of an installed Eliza-1 bundle.
 *
 * `installed` and `manifestLoader` are both optional — passing neither
 * always returns the catalog-scalar fallback. The recommendation engine
 * passes both at call sites where it has the installed-models list.
 */
export function resolveRamBudget(
	model,
	installed,
	manifestLoader = defaultManifestLoader,
) {
	if (isEliza1TierId(model.id) && installed) {
		const manifest = manifestLoader(model.id, installed);
		if (manifest) {
			return {
				minMb: manifest.ramBudgetMb.min,
				recommendedMb: manifest.ramBudgetMb.recommended,
				source: "manifest",
			};
		}
	}
	const minMb = Math.round(model.minRamGb * MB_PER_GB);
	return {
		minMb,
		recommendedMb: catalogRecommendedMb(model, minMb),
		source: "catalog",
	};
}
/**
 * The one fit decision. `hostRamMb` is the memory being assessed against,
 * in megabytes (`os.totalmem() / 2**20`, or the probe's `totalRamGb * 1024`,
 * or — for the recommender on a GPU host — the effective model-available
 * memory in MB).
 *
 *   - `wontfit` : usable RAM (host minus headroom) is below the bundle's
 *                 boot floor (`budget.minMb`). A load MUST be refused.
 *   - `tight`   : boots, but usable RAM is below the recommended budget —
 *                 a long session will swap or stutter under load.
 *   - `fits`    : comfortable headroom.
 */
export function assessRamFit(model, hostRamMb, options = {}) {
	const budget = resolveRamBudget(
		model,
		options.installed,
		options.manifestLoader ?? defaultManifestLoader,
	);
	const reserveMb = options.reserveMb ?? ramHeadroomReserveMb();
	const usableMb = Math.max(0, hostRamMb - reserveMb);
	let level;
	if (usableMb < budget.minMb) level = "wontfit";
	else if (usableMb < budget.recommendedMb) level = "tight";
	else level = "fits";
	return {
		level,
		fits: level !== "wontfit",
		budget,
		usableMb,
		reserveMb,
	};
}
/** Display name with a trailing `-<ctx>` window suffix stripped. */
function contextVariantStem(model) {
	return model.displayName.replace(/-(?:\d+k|\d+m)$/i, "");
}
/**
 * Given a catalog entry, pick the variant of the same model "line" (same
 * param count and display-name stem — e.g. `eliza-1-27b` / `eliza-1-27b-256k`
 * ) with the largest context window that still fits a
 * host with `hostRamMb` of RAM. Returns `model` itself when it's already
 * the best fit (or the only variant), or `null` when not even `model` fits
 * — callers turn that into a refusal.
 *
 * Variants are matched by `(params, displayNameStem)` where the stem is the
 * display name with any trailing `-<ctx>` suffix (`-256k`, `-1m`, `-128k`)
 * stripped. This keeps `eliza-1-27b*` together without conflating `9b` and
 * `27b`. Only `runtimeRole !== "dflash-drafter"` entries are candidates.
 */
export function pickFittingContextVariant(
	model,
	hostRamMb,
	options = {},
	catalog = MODEL_CATALOG,
) {
	const stem = contextVariantStem(model);
	const variants = catalog.filter(
		(candidate) =>
			candidate.runtimeRole !== "dflash-drafter" &&
			candidate.params === model.params &&
			contextVariantStem(candidate) === stem,
	);
	// Largest context first; ties (shouldn't happen) keep catalog order.
	const ranked = [...(variants.length > 0 ? variants : [model])].sort(
		(left, right) => (right.contextLength ?? 0) - (left.contextLength ?? 0),
	);
	for (const candidate of ranked) {
		const installed = candidate.id === model.id ? options.installed : undefined;
		if (assessRamFit(candidate, hostRamMb, { ...options, installed }).fits) {
			return candidate;
		}
	}
	return null;
}
//# sourceMappingURL=ram-budget.js.map
