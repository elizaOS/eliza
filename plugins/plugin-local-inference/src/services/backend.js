/**
 * Local-inference backend interface and dispatcher.
 *
 * Two real implementations live behind this interface:
 *
 *   - `node-llama-cpp`  → in-process via the node-llama-cpp binding. Stock
 *     GGUFs, no drafter, no MoE expert offload, no `--lookahead`. Fastest
 *     to start, lowest IPC overhead, narrowest feature surface.
 *   - `llama-server`    → out-of-process llama-server (the buun-llama-cpp
 *     fork). Full optimization surface — DFlash, n-gram drafter, lookahead,
 *     `-ot` MoE offload, TurboQuant KV cache, mlock/no-mmap/mmproj, etc.
 *
 * The dispatcher decides which one to use per-load based on:
 *
 *   1. `ELIZA_LOCAL_BACKEND=node-llama-cpp|llama-server|auto` — operator
 *      override. `auto` (the default) hands the decision to the catalog.
 *   2. Catalog `runtime.optimizations.requiresKernel` — if any specialised
 *      llama-server kernel is required (e.g. `dflash`, `turbo3`), the
 *      dispatcher MUST pick `llama-server`. The in-process binding cannot
 *      provide these kernels at all.
 *   3. Catalog `runtime.preferredBackend` — soft preference. We pick
 *      `llama-server` when this is set AND the binary is available;
 *      otherwise we fall back to `node-llama-cpp` unless DFlash is
 *      explicitly required (`ELIZA_DFLASH_REQUIRED=1`).
 *   4. Default: `node-llama-cpp` for stock GGUFs without runtime metadata.
 *
 * The dispatcher does NOT own the spawn body — `llama-server` and the
 * node binding own that. It owns selection only, plus a small load-state
 * cache so callers can swap models without touching either backend
 * directly.
 */
import { findCatalogModel } from "./catalog";
export function gpuLayersForKvOffload(mode) {
	if (mode === "cpu") return 0;
	if (mode === "gpu") return "max";
	if (mode === "split") return "auto";
	return mode.gpuLayers;
}
export function readBackendOverride() {
	const raw = process.env.ELIZA_LOCAL_BACKEND?.trim().toLowerCase();
	if (raw === "node-llama-cpp" || raw === "llama-server" || raw === "auto") {
		return raw;
	}
	return "auto";
}
function envFlag(name) {
	const v = process.env[name]?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}
/**
 * Opt-in "reduced-optimization local mode" (the cross-platform escape hatch
 * documented in `docs/voice-interactive.md` and `packages/inference/AGENTS.md`
 * §4): when the installed `llama-server` binary does not advertise the
 * custom Eliza-1 KV kernels (`turbo3`/`qjl_full`/`polarquant`/…) — i.e. the
 * fork hasn't been built with those kernels dispatched on this backend yet —
 * setting `ELIZA_LOCAL_ALLOW_STOCK_KV=1` lets the model load anyway with
 * stock `f16` KV cache instead of hard-refusing. The voice pipeline runs;
 * it just runs without the KV-compression speedups on that backend. A loud
 * one-time warning is emitted (see `warnReducedOptimizationLocalMode`).
 *
 * §3-vs-"works everywhere" reconciliation: AGENTS.md §3 says these kernels
 * are *mandatory* and there is *no* "fallback to unoptimized" path. The
 * user's directive for SA-1 is "works everywhere regardless of GPU". The
 * reconciliation: the kernels DO build on every backend where they can be
 * dispatched (Metal, CUDA, Vulkan-source-patched, CPU SIMD TUs), and this
 * fallback is the *opt-in*, *loudly-warned*, *non-publishable* mode for the
 * backends where dispatch isn't wired yet — it is not a silent downgrade,
 * and `defaultEligible` bundles still require the verified kernels.
 */
export function localAllowStockKv() {
	return envFlag("ELIZA_LOCAL_ALLOW_STOCK_KV");
}
let reducedModeWarned = false;
export function warnReducedOptimizationLocalMode(detail) {
	if (reducedModeWarned) return;
	reducedModeWarned = true;
	console.warn(
		`\n[local-inference] ⚠️  REDUCED-OPTIMIZATION LOCAL MODE — ${detail}\n` +
			`  ELIZA_LOCAL_ALLOW_STOCK_KV=1 is set, so the model is loading with stock\n` +
			`  f16 KV cache instead of the Eliza-1 TurboQuant/QJL/PolarQuant KV kernels.\n` +
			`  The voice pipeline will run, but slower and using more memory than a build\n` +
			`  with the kernels dispatched (Metal: all 5; CUDA: ships them; Vulkan: source-\n` +
			`  patched; CPU: SIMD TUs). Rebuild the fork with the matching backend\n` +
			`  (node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>)\n` +
			`  to get the optimized path. This mode is NOT publishable and NOT a default.\n`,
	);
}
/** Reset the one-time warning latch (tests only). */
export function __resetReducedModeWarnedForTests() {
	reducedModeWarned = false;
}
/**
 * Pure decision function. Easy to unit-test without spawning anything.
 *
 * Inputs are deliberately explicit — the caller resolves the catalog entry,
 * the binary availability, and the env override before calling us.
 *
 * `binaryKernels`, when present, is the parsed CAPABILITIES.json kernels
 * map from the installed llama-server build. The dispatcher uses it to
 * compute `unsatisfiedKernels`; null means the binary is older / has no
 * capabilities probe, in which case we trust the model's declaration and
 * let the load attempt clarify.
 */
export function decideBackend(input) {
	const { override, catalog, llamaServerAvailable, dflashRequired } = input;
	const optimizations = catalog?.runtime?.optimizations;
	const kernels = optimizations?.requiresKernel ?? [];
	const dflashConfigured = catalog?.runtime?.dflash;
	const preferredBackend = catalog?.runtime?.preferredBackend;
	const unsatisfiedKernels = computeUnsatisfiedKernels(
		kernels,
		input.binaryKernels ?? null,
	);
	if (override === "node-llama-cpp") {
		if (kernels.length > 0 || dflashRequired) {
			// The override conflicts with a hard requirement. Prefer the kernel
			// requirement — silently honoring the override would silently break
			// the model. Surface as a llama-server pick; the load itself will
			// fail clearly if the binary really is missing.
			return {
				backend: "llama-server",
				reason: "kernel-required",
				kernels,
				unsatisfiedKernels,
			};
		}
		return {
			backend: "node-llama-cpp",
			reason: "env-override",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (override === "llama-server") {
		return {
			backend: "llama-server",
			reason: "env-override",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (kernels.length > 0) {
		return {
			backend: "llama-server",
			reason: "kernel-required",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (dflashConfigured && dflashRequired) {
		return {
			backend: "llama-server",
			reason: "dflash-required",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (preferredBackend === "llama-server" && llamaServerAvailable) {
		return {
			backend: "llama-server",
			reason: "preferred-backend",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (preferredBackend === "node-llama-cpp") {
		return {
			backend: "node-llama-cpp",
			reason: "preferred-backend",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (llamaServerAvailable) {
		return {
			backend: "llama-server",
			reason: "default",
			kernels,
			unsatisfiedKernels,
		};
	}
	return {
		backend: "node-llama-cpp",
		reason: "default",
		kernels,
		unsatisfiedKernels,
	};
}
/**
 * Returns the subset of `required` kernels that aren't reported as `true`
 * in the binary's CAPABILITIES.json. Returns undefined when no probe is
 * available; an empty array means "all required kernels are satisfied".
 */
function computeUnsatisfiedKernels(required, binaryKernels) {
	if (required.length === 0) return undefined;
	if (!binaryKernels) return undefined;
	return required.filter((k) => binaryKernels[k] !== true);
}
/**
 * Resolve the catalog entry for a `BackendPlan`. Plans may carry the entry
 * already (when the caller has it on hand), reference it by id, or carry
 * neither — in which case the dispatcher falls back to the default backend.
 */
export function resolveCatalogForPlan(plan) {
	if (plan.catalog) return plan.catalog;
	if (plan.modelId) return findCatalogModel(plan.modelId);
	return undefined;
}
/**
 * Dispatcher that fronts both backends behind the `LocalInferenceBackend`
 * contract. Holds at most one active backend at a time — load() unloads
 * the previous backend before loading the new one if they differ.
 */
export class BackendDispatcher {
	nodeLlamaCpp;
	llamaServer;
	probeLlamaServerAvailable;
	probeDflashRequired;
	probeBinaryKernels;
	id = "node-llama-cpp";
	// The dispatcher's `id` is informational; the active backend's id is what
	// matters for diagnostics. We expose `activeBackendId()` for that.
	active = null;
	constructor(
		nodeLlamaCpp,
		llamaServer,
		probeLlamaServerAvailable,
		probeDflashRequired,
		/**
		 * Optional capabilities probe that returns the kernels map from
		 * CAPABILITIES.json next to the installed llama-server binary, or
		 * null when the file is absent. Used to flag `unsatisfiedKernels`
		 * in the BackendDecision before load() so callers can give a clean
		 * "rebuild your fork binary" error instead of a kernel SIGSEGV at
		 * generation time.
		 */
		probeBinaryKernels,
	) {
		this.nodeLlamaCpp = nodeLlamaCpp;
		this.llamaServer = llamaServer;
		this.probeLlamaServerAvailable = probeLlamaServerAvailable;
		this.probeDflashRequired = probeDflashRequired;
		this.probeBinaryKernels = probeBinaryKernels;
	}
	async available() {
		const a = await this.nodeLlamaCpp.available();
		if (a) return true;
		return this.llamaServer.available();
	}
	activeBackendId() {
		return this.active ? this.active.id : null;
	}
	hasLoadedModel() {
		return this.active?.hasLoadedModel() ?? false;
	}
	currentModelPath() {
		return this.active?.currentModelPath() ?? null;
	}
	decide(plan) {
		const catalog = resolveCatalogForPlan(plan);
		return decideBackend({
			override: readBackendOverride(),
			catalog,
			llamaServerAvailable: this.probeLlamaServerAvailable(),
			dflashRequired: this.probeDflashRequired(),
			binaryKernels: this.probeBinaryKernels?.() ?? null,
		});
	}
	async load(plan) {
		let effectivePlan = plan;
		const decision = this.decide(plan);
		if (decision.unsatisfiedKernels && decision.unsatisfiedKernels.length > 0) {
			const missing = decision.unsatisfiedKernels.join(", ");
			if (localAllowStockKv()) {
				// Reduced-optimization local mode: the build hasn't dispatched these
				// kernels on this backend yet, but the user opted into running with
				// stock f16 KV instead of hard-refusing. Strip any custom cache-type
				// override from the plan so the llama-server spawn uses f16, and warn
				// loudly exactly once.
				warnReducedOptimizationLocalMode(
					`catalog model requires kernel(s) {${missing}}, not advertised by the installed llama-server binary`,
				);
				if (
					plan.overrides &&
					(plan.overrides.cacheTypeK !== undefined ||
						plan.overrides.cacheTypeV !== undefined)
				) {
					const { cacheTypeK: _k, cacheTypeV: _v, ...rest } = plan.overrides;
					effectivePlan = { ...plan, overrides: { ...rest } };
				}
			} else {
				throw new Error(
					`[local-inference] Catalog model requires kernel(s) {${missing}}, but the installed llama-server binary does not advertise them in CAPABILITIES.json. Rebuild the fork with the matching backend (e.g. node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>), pick a different model, or set ELIZA_LOCAL_ALLOW_STOCK_KV=1 to load with stock f16 KV (reduced-optimization local mode — loud warning, not publishable).`,
				);
			}
		}
		const target =
			decision.backend === "llama-server"
				? this.llamaServer
				: this.nodeLlamaCpp;
		if (this.active && this.active !== target) {
			await this.active.unload();
		}
		this.active = target;
		await target.load(effectivePlan);
	}
	async unload() {
		const active = this.active;
		this.active = null;
		if (active) await active.unload();
	}
	async generate(args) {
		if (!this.active) {
			throw new Error(
				"[local-inference] No backend loaded. Call load() before generate().",
			);
		}
		return this.active.generate(args);
	}
	async embed(args) {
		if (!this.active) {
			throw new Error(
				"[local-inference] No backend loaded. Call load() before embed().",
			);
		}
		if (!this.active.embed) {
			throw new Error(
				`[local-inference] Active backend (${this.active.id}) does not implement embed.`,
			);
		}
		return this.active.embed(args);
	}
}
//# sourceMappingURL=backend.js.map
