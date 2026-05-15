import {
	DEFAULT_ELIGIBLE_MODEL_IDS,
	eliza1TierPublishStatus,
	FIRST_RUN_DEFAULT_MODEL_ID,
	MODEL_CATALOG,
} from "./catalog";
import { canSetAsDefault, SUPPORTED_BACKENDS_BY_TIER } from "./manifest";
import { assessRamFit, defaultManifestLoader } from "./ram-budget";

const TIER_0_8B = "eliza-1-0_8b";
const TIER_2B = "eliza-1-2b";
const TIER_4B = "eliza-1-4b";
const TIER_9B = "eliza-1-9b";
const TIER_27B = "eliza-1-27b";
const TIER_27B_256K = "eliza-1-27b-256k";
const BYTES_PER_GB = 1024 ** 3;
/**
 * Per-platform slot ladders. Every default-recommended entry is an
 * Eliza-1 tier (the only default-eligible line — see catalog.ts and
 * `packages/inference/AGENTS.md` §2). Ladders bias toward the smallest
 * tier that fits the platform; desktops/servers pick larger tiers
 * first when memory headroom allows.
 */
const SLOT_LADDERS = {
	mobile: {
		TEXT_SMALL: [TIER_0_8B],
		TEXT_LARGE: [TIER_4B, TIER_2B, TIER_0_8B],
	},
	"apple-silicon": {
		TEXT_SMALL: [TIER_0_8B, TIER_2B, TIER_4B],
		TEXT_LARGE: [TIER_27B, TIER_9B, TIER_4B, TIER_2B, TIER_0_8B],
	},
	"linux-gpu": {
		TEXT_SMALL: [TIER_0_8B, TIER_2B, TIER_4B],
		TEXT_LARGE: [TIER_27B_256K, TIER_27B, TIER_9B, TIER_4B, TIER_2B, TIER_0_8B],
	},
	"linux-cpu": {
		TEXT_SMALL: [TIER_0_8B, TIER_2B, TIER_4B],
		TEXT_LARGE: [TIER_9B, TIER_4B, TIER_2B, TIER_0_8B],
	},
	"desktop-gpu": {
		TEXT_SMALL: [TIER_0_8B, TIER_2B, TIER_4B],
		TEXT_LARGE: [TIER_27B_256K, TIER_27B, TIER_9B, TIER_4B, TIER_2B, TIER_0_8B],
	},
	"desktop-cpu": {
		TEXT_SMALL: [TIER_0_8B, TIER_2B, TIER_4B],
		TEXT_LARGE: [TIER_9B, TIER_4B, TIER_2B, TIER_0_8B],
	},
};
function catalogById(catalog) {
	return new Map(catalog.map((model) => [model.id, model]));
}
function chatCandidates(catalog) {
	return catalog.filter(
		(model) =>
			!model.hiddenFromCatalog && model.runtimeRole !== "dflash-drafter",
	);
}
export function classifyRecommendationPlatform(hardware) {
	// Mobile detection comes from the typed `hardware.mobile.platform`
	// field (`"ios" | "android" | "web"`). `NodeJS.Platform` doesn't
	// include those values — the previous `process.platform as string`
	// cast was hiding that the cast was the only way the comparison
	// type-checked. Reading the proper typed field is both safer and
	// accurate when a host advertises mobile via the mobile probe.
	const mobilePlatform = hardware.mobile?.platform;
	if (mobilePlatform === "android" || mobilePlatform === "ios") return "mobile";
	const platform = hardware.platform;
	if (hardware.appleSilicon) return "apple-silicon";
	if (platform === "linux" && hardware.gpu) return "linux-gpu";
	if (platform === "linux") return "linux-cpu";
	if (hardware.gpu) return "desktop-gpu";
	return "desktop-cpu";
}
export function catalogDownloadSizeGb(model, catalog = MODEL_CATALOG) {
	const byId = catalogById(catalog);
	return (model.companionModelIds ?? []).reduce((total, companionId) => {
		const companion = byId.get(companionId);
		return total + (companion?.sizeGb ?? 0);
	}, model.sizeGb);
}
export function catalogDownloadSizeBytes(model, catalog = MODEL_CATALOG) {
	return Math.round(catalogDownloadSizeGb(model, catalog) * BYTES_PER_GB);
}
export function selectBestQuantizationVariant(model) {
	const quantization = model.quantization;
	if (!quantization) return null;
	return (
		quantization.variants.find(
			(variant) => variant.id === quantization.defaultVariantId,
		) ??
		quantization.variants.find((variant) => variant.status === "published") ??
		quantization.variants[0] ??
		null
	);
}
const MB_PER_GB = 1024;
/**
 * Memory the model can actually use on this host, in GB. On Apple Silicon
 * and mobile the GPU shares system RAM, so total RAM acts as the budget.
 * On discrete-GPU x86 the KV cache + weights live wherever the layers do —
 * weight VRAM higher. CPU-only hosts can give about half of RAM to a model
 * before paging hurts.
 */
function effectiveMemoryGb(probe) {
	if (probe.appleSilicon) return probe.totalRamGb;
	if (probe.gpu) {
		return Math.max(probe.gpu.totalVramGb, probe.totalRamGb * 0.5);
	}
	return probe.totalRamGb * 0.5;
}
/**
 * Download-size guardrail layered on top of the RAM-budget fit decision:
 * a bundle whose on-disk footprint is a large fraction of the available
 * memory will swap even if the RAM-budget floor says it boots. Returns
 * `"wontfit"` / `"tight"` / `null` ("the size is fine; defer to the
 * RAM-budget level"). Ratios match the historical `assessFit` (desktop)
 * and `mobileFit` (mobile) thresholds.
 */
function downloadSizeGuardrail(hardware, model, catalog, isMobile) {
	const sizeGb = catalogDownloadSizeGb(model, catalog);
	const memGb = isMobile ? hardware.totalRamGb : effectiveMemoryGb(hardware);
	const wontFitRatio = isMobile ? 0.8 : 0.9;
	const tightRatio = isMobile ? 0.65 : 0.7;
	if (sizeGb > memGb * wontFitRatio) return "wontfit";
	if (sizeGb > memGb * tightRatio) return "tight";
	return null;
}
export function assessCatalogModelFit(
	hardware,
	model,
	catalog = MODEL_CATALOG,
	options = {},
) {
	if (model.runtime?.dflash) {
		const byId = catalogById(catalog);
		if (!byId.has(model.runtime.dflash.drafterModelId)) return "wontfit";
	}
	const isMobile = classifyRecommendationPlatform(hardware) === "mobile";
	const memGb = isMobile ? hardware.totalRamGb : effectiveMemoryGb(hardware);
	// Single source of truth for the RAM floor + fits-vs-tight cutoff:
	// `ram-budget.assessRamFit`. The recommender works in "memory available
	// to the model" terms (VRAM-weighted on GPU hosts), so the OS headroom
	// reserve is already discounted — pass `reserveMb: 0`.
	const ramFit = assessRamFit(model, memGb * MB_PER_GB, {
		installed: options.installed,
		manifestLoader: options.manifestLoader ?? defaultManifestLoader,
		reserveMb: 0,
	});
	if (!ramFit.fits) return "wontfit";
	const sizeLevel = downloadSizeGuardrail(hardware, model, catalog, isMobile);
	if (sizeLevel === "wontfit") return "wontfit";
	if (sizeLevel === "tight" || ramFit.level === "tight") return "tight";
	return "fits";
}
function canFit(hardware, model, catalog, options = {}) {
	return assessCatalogModelFit(hardware, model, catalog, options) !== "wontfit";
}
/**
 * True when every kernel listed in `model.runtime.optimizations.requiresKernel`
 * is advertised as `true` in the binary's CAPABILITIES.json kernels map.
 *
 * `binaryKernels === null` means we have no probe (older binary, or
 * llama-server isn't installed). In that case we trust the catalog —
 * filtering would hide every kernel-required model and the dispatcher's
 * load-time check will surface the real error if/when the user tries to
 * activate it.
 */
function kernelRequirementsSatisfied(model, binaryKernels) {
	const required = model.runtime?.optimizations?.requiresKernel ?? [];
	if (required.length === 0) return true;
	if (!binaryKernels) return true;
	return required.every((k) => binaryKernels[k] === true);
}
function modelsFromLadder(ids, catalog) {
	const byId = catalogById(catalog);
	return ids.flatMap((id) => {
		const model = byId.get(id);
		return model ? [model] : [];
	});
}
/**
 * True when this host has enough memory headroom to serve the long-context
 * KV cache for a 64k+ window. Threshold mirrors the "16 GB workstation"
 * line from the porting plan — a 64k context for an 8B model at fp16 KV
 * occupies ~4 GB; with TurboQuant compression it fits inside 1 GB. Below
 * 16 GB total we keep the historical short-context preference.
 *
 * For GPU hosts we look at total VRAM, since the KV cache lives wherever
 * the layers do; for CPU-only hosts we look at total RAM.
 */
const LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB = 16;
const LONG_CONTEXT_MIN_LENGTH = 65536;
function hasLongContextHeadroom(hardware) {
	const vramGb = hardware.gpu?.totalVramGb ?? 0;
	if (vramGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB) return true;
	return hardware.totalRamGb >= LONG_CONTEXT_RAM_BUMP_THRESHOLD_GB;
}
function isLongContextModel(model) {
	return (
		typeof model.contextLength === "number" &&
		model.contextLength >= LONG_CONTEXT_MIN_LENGTH
	);
}
function fallbackCandidates(slot, hardware, catalog, budgetOptions) {
	const candidates = chatCandidates(catalog).filter(
		(model) =>
			DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id) &&
			canFit(
				hardware,
				model,
				catalog,
				budgetOptionsForModel(model, budgetOptions),
			),
	);
	const preferLongContext = hasLongContextHeadroom(hardware);
	return candidates.sort((left, right) => {
		if (preferLongContext) {
			const leftLong = isLongContextModel(left) ? 1 : 0;
			const rightLong = isLongContextModel(right) ? 1 : 0;
			if (leftLong !== rightLong) return rightLong - leftLong;
		}
		const sizeDelta =
			catalogDownloadSizeGb(right, catalog) -
			catalogDownloadSizeGb(left, catalog);
		return slot === "TEXT_LARGE" ? sizeDelta : -sizeDelta;
	});
}
function budgetOptionsForModel(model, budget) {
	return {
		installed: budget.installed.find((m) => m.id === model.id),
		manifestLoader: budget.manifestLoader,
	};
}
function resolveBudgetOptions(options) {
	return {
		installed: options.installed ?? [],
		manifestLoader: options.manifestLoader ?? defaultManifestLoader,
	};
}
export function selectRecommendedModelForSlot(
	slot,
	hardware,
	catalog = MODEL_CATALOG,
	options = {},
) {
	const platformClass = classifyRecommendationPlatform(hardware);
	const ladder = modelsFromLadder(SLOT_LADDERS[platformClass][slot], catalog);
	const binaryKernels = options.binaryKernels ?? null;
	const budget = resolveBudgetOptions(options);
	const eligible = ladder.filter(
		(model) =>
			canFit(hardware, model, catalog, budgetOptionsForModel(model, budget)) &&
			kernelRequirementsSatisfied(model, binaryKernels),
	);
	// On hosts with >= 16 GB RAM/VRAM, give long-context (>= 64k) ladder
	// entries a small bump so we surface 128k models when they fit. The
	// ladder order still wins when long-context availability is the same
	// for every entry (or when the host doesn't have the headroom).
	const ranked =
		slot === "TEXT_LARGE" &&
		eligible.length > 0 &&
		hasLongContextHeadroom(hardware)
			? rankLadderByLongContext(eligible)
			: eligible;
	const alternatives =
		ranked.length > 0
			? ranked
			: fallbackCandidates(slot, hardware, catalog, budget).filter((model) =>
					kernelRequirementsSatisfied(model, binaryKernels),
				);
	const model = alternatives[0] ?? null;
	const fit = model
		? assessCatalogModelFit(
				hardware,
				model,
				catalog,
				budgetOptionsForModel(model, budget),
			)
		: null;
	return {
		slot,
		platformClass,
		model,
		fit,
		reason: model
			? `${platformClass} ${slot} ladder selected ${model.id}`
			: `${platformClass} ${slot} ladder has no fitting catalog model`,
		alternatives,
	};
}
/**
 * Stable sort that pulls long-context models toward the front while
 * preserving relative order within each group. Used only on hosts with
 * the long-context RAM/VRAM headroom — the ladder order remains the
 * tie-breaker so DFlash-first preferences survive.
 */
function rankLadderByLongContext(ladder) {
	return ladder
		.map((model, idx) => ({ model, idx, long: isLongContextModel(model) }))
		.sort((left, right) => {
			if (left.long !== right.long) return right.long ? 1 : -1;
			return left.idx - right.idx;
		})
		.map((entry) => entry.model);
}
// ---------------------------------------------------------------------------
// Default-eligibility on this device — the recommendation-engine gate that
// consults the bundle's `eliza-1.manifest.json` (`kernels.verifiedBackends`,
// `evals`, `defaultEligible`) against the device hardware + the bundle's
// on-device verify state. See `packages/inference/AGENTS.md` §6 + §7.
// ---------------------------------------------------------------------------
/**
 * Project a `HardwareProbe` onto the `Eliza1DeviceCaps` shape the manifest
 * validator's `canSetAsDefault` consumes. CPU is always available; a probed
 * GPU contributes exactly its one backend (`cuda` / `metal` / `vulkan`). RAM
 * is the device total, in MB — `canSetAsDefault` compares against the
 * manifest's `ramBudgetMb.min` floor, not the headroom-discounted figure the
 * ladder uses, because the floor is "will it boot at all".
 */
export function deviceCapsFromProbe(hardware) {
	const backends = ["cpu"];
	if (hardware.gpu) backends.push(hardware.gpu.backend);
	return {
		availableBackends: backends,
		ramMb: Math.round(hardware.totalRamGb * 1024),
	};
}
/**
 * True iff this installed Eliza-1 bundle may be offered as the recommended
 * default on this device. The full set of conditions (any one failing →
 * not default):
 *
 *  - the bundle ships a validated `eliza-1.manifest.json`,
 *  - the manifest is contract-valid (every required kernel declared, every
 *    required eval green for a strict release, lineage/files consistent —
 *    enforced by `canSetAsDefault` → `collectContractErrors`),
 *  - the device exposes at least one backend the manifest verified `pass` on
 *    out of the tier's supported set,
 *  - the device RAM meets the manifest's `ramBudgetMb.min` floor,
 *  - the bundle has passed the one-time on-device verify pass
 *    (`InstalledModel.bundleVerifiedAt` is set) — a materialized-but-unverified
 *    bundle is never auto-selected, per AGENTS.md §7.
 *
 * `manifest.defaultEligible: true` is NOT required at the gate level — a
 * `base-v1-candidate` bundle that passes every above condition is allowed
 * to fill an empty default slot. The recommender prefers a strict release
 * (`defaultEligible: true`) over a candidate when both are installed.
 */
export function canBundleBeDefaultOnDevice(installed, hardware, options = {}) {
	const loader = options.manifestLoader ?? defaultManifestLoader;
	const manifest = loader(installed.id, installed);
	if (!manifest) {
		return {
			canBeDefault: false,
			reason: "no-manifest",
			detail: `${installed.id}: no validated eliza-1.manifest.json next to the bundle`,
		};
	}
	if (!installed.bundleVerifiedAt) {
		return {
			canBeDefault: false,
			reason: "not-verified-on-device",
			detail: `${installed.id}: bundle materialized but the on-device verify pass (load → 1-token text → 1-phrase voice → barge-in) has not run`,
		};
	}
	const caps = deviceCapsFromProbe(hardware);
	if (canSetAsDefault(manifest, caps)) return { canBeDefault: true };
	// canSetAsDefault returned false — disambiguate why so the UI/log is precise.
	if (manifest.ramBudgetMb.min > caps.ramMb) {
		return {
			canBeDefault: false,
			reason: "ram-below-floor",
			detail: `${installed.id}: device RAM ${caps.ramMb} MB is below the manifest floor ${manifest.ramBudgetMb.min} MB`,
		};
	}
	const supported = new Set(SUPPORTED_BACKENDS_BY_TIER[manifest.tier]);
	const verifiedOnDeviceBackend = caps.availableBackends.some(
		(b) =>
			supported.has(b) &&
			manifest.kernels.verifiedBackends[b].status === "pass",
	);
	if (!verifiedOnDeviceBackend) {
		const deviceBackends = caps.availableBackends.join(", ");
		return {
			canBeDefault: false,
			reason: "kernels-unverified-on-device",
			detail: `${installed.id}: no backend the device exposes (${deviceBackends}) has a 'pass' kernel-verify report in the manifest`,
		};
	}
	// RAM ok, backend ok — the failure must be a manifest-contract path the
	// validator caught (e.g. a required-eval gate not passed for a strict
	// release, a lineage/files mismatch, an inconsistent provenance block).
	// All contract failures make the bundle ineligible to be the device default.
	return {
		canBeDefault: false,
		reason: "not-default-eligible",
		detail: `${installed.id}: manifest failed the contract check (an eval gate, kernel-coverage rule, or lineage/files consistency rule)`,
	};
}
export function selectRecommendedModels(
	hardware,
	catalog = MODEL_CATALOG,
	options = {},
) {
	return {
		TEXT_SMALL: selectRecommendedModelForSlot(
			"TEXT_SMALL",
			hardware,
			catalog,
			options,
		),
		TEXT_LARGE: selectRecommendedModelForSlot(
			"TEXT_LARGE",
			hardware,
			catalog,
			options,
		),
	};
}
/**
 * Pick the model the engine should auto-load on first run when no user
 * preference exists. Always resolves to an Eliza-1 default-eligible
 * tier — never a non-Eliza catalog entry, never a HF-search result.
 *
 * Resolution order:
 *   1. `FIRST_RUN_DEFAULT_MODEL_ID` when present in the catalog, in the
 *      default-eligible set, and not marked `publishStatus: "pending"`.
 *   2. The first default-eligible, non-pending chat entry in the catalog
 *      as a fallback when the preferred id is missing or its HF bundle
 *      isn't published yet (elizaOS/eliza#7629). The fall-through walks
 *      the catalog in order, so the maintainer can keep
 *      `FIRST_RUN_DEFAULT_MODEL_ID` pointed at the *intended* default
 *      while the publish pipeline catches up.
 *   3. If every default-eligible tier is pending, last-resort to ANY
 *      default-eligible tier — the device download path will fail
 *      cleanly with a 404 rather than silently picking a private
 *      non-Eliza model.
 *
 * Returns null only when no default-eligible entry exists at all —
 * which means the catalog is misconfigured and the caller should
 * surface a hard error rather than degrade silently.
 */
export function recommendForFirstRun(catalog = MODEL_CATALOG) {
	const byId = catalogById(catalog);
	const isEligibleChat = (model) =>
		!model.hiddenFromCatalog &&
		model.runtimeRole !== "dflash-drafter" &&
		DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id);
	const publishStatusFor = (model) =>
		model.publishStatus ?? eliza1TierPublishStatus(model.id);
	const isPublishedEligibleChat = (model) =>
		isEligibleChat(model) && publishStatusFor(model) === "published";
	const preferred = byId.get(FIRST_RUN_DEFAULT_MODEL_ID);
	if (preferred && isPublishedEligibleChat(preferred)) return preferred;
	// Preferred is missing or its bundle is still being published — walk the
	// catalog for the first eligible chat tier whose bundle IS published.
	const fallbackPublished = catalog.find(isPublishedEligibleChat);
	if (fallbackPublished) return fallbackPublished;
	// Every eligible tier is "pending" — last-resort to the preferred tier
	// when it exists in the catalog, otherwise the first default-eligible
	// chat entry. Either path lets the downloader emit a clear "manifest
	// 404" message rather than silently picking a non-Eliza model.
	if (preferred && isEligibleChat(preferred)) return preferred;
	return catalog.find(isEligibleChat) ?? null;
}
export function chooseSmallerFallbackModel(
	currentModelId,
	hardware,
	slot = "TEXT_LARGE",
	catalog = MODEL_CATALOG,
	options = {},
) {
	const byId = catalogById(catalog);
	const current = byId.get(currentModelId);
	const currentSize = current
		? catalogDownloadSizeGb(current, catalog)
		: Number.POSITIVE_INFINITY;
	const platformClass = classifyRecommendationPlatform(hardware);
	const budget = resolveBudgetOptions(options);
	const ladderFallback = modelsFromLadder(
		SLOT_LADDERS[platformClass][slot],
		catalog,
	)
		.filter((model) => model.id !== currentModelId)
		.filter((model) => catalogDownloadSizeGb(model, catalog) < currentSize)
		.filter((model) =>
			canFit(hardware, model, catalog, budgetOptionsForModel(model, budget)),
		)[0];
	if (ladderFallback) return ladderFallback;
	return (
		fallbackCandidates(slot, hardware, catalog, budget)
			.filter((model) => model.id !== currentModelId)
			.filter(
				(model) => catalogDownloadSizeGb(model, catalog) < currentSize,
			)[0] ?? null
	);
}
//# sourceMappingURL=recommendation.js.map
