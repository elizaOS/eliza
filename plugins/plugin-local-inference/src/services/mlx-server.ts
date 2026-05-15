// mlx-server.ts — Apple-Silicon MLX eligibility helpers (in-process-only).
//
// HISTORY: this module previously spawned `mlx_lm.server` as a child process
// and routed completions over HTTP (`POST http://127.0.0.1:<port>/v1/chat/
// completions`). Local inference is required to be in-process — no subprocesses,
// no TCP — so the spawn/HTTP transport has been removed. See
// `plugins/plugin-local-inference/MLX_IN_PROCESS_PLAN.md` for the concrete blocker and unblock
// plan.
//
// What remains:
//   * Eligibility helpers (`mlxOptIn`, `isAppleSilicon`, `resolveMlxPython`,
//     `looksLikeMlxModelDir`, `resolveMlxModelDir`, `mlxBackendEligible`) so
//     diagnostics, `/api/local-inference/active`, and the recommendation
//     surface can keep reporting MLX-related state honestly.
//   * `MlxLocalServer` is now a no-op stub: `hasLoadedModel()` is always
//     `false`, `load()` always throws, `generate()` always throws. This
//     preserves the engine fallthrough shape — `engine.ts` already only
//     forwarded to `mlxLocalServer.generate(args)` when `hasLoadedModel()`
//     returned `true`, which was never reached in production because no
//     production callsite ever invoked `load()`.
//
// HONESTY CONTRACT (unchanged from before):
//   * MLX has its own quantization (4-bit / 8-bit affine, GPTQ-ish). It does
//     NOT implement the §3 mandatory kernels — no TurboQuant K/V cache, no
//     QJL, no PolarQuant. So an MLX backend can NEVER satisfy the build/runtime
//     required-kernel contract; it is the same class as the reduced-optimization
//     local mode (`ELIZA_LOCAL_ALLOW_STOCK_KV=1`). `defaultEligible` bundles
//     keep requiring the verified fork kernels — MLX never flips
//     `verifiedBackends.mlx`.
//   * MLX does NOT carry OmniVoice TTS / Qwen3-ASR. The voice pipeline is NOT
//     routed through MLX — the fused `llama-server` (Metal) / in-process FFI is
//     the voice path on Apple. This module is text-completion only.
//
// Opt-in (still observed by eligibility, even though no runtime exists today):
//   `ELIZA_LOCAL_MLX=1` (or `ELIZA_LOCAL_BACKEND=mlx-server`).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GenerateArgs } from "./backend";

/** Identifier surfaced in diagnostics / `/api/local-inference/active`. */
export const MLX_BACKEND_ID = "mlx-server" as const;

function envFlag(name: string): boolean {
	const v = process.env[name]?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * True only on Apple Silicon. MLX is Metal-only; on Intel macs / Linux /
 * Windows the package either isn't installed or falls back to CPU at a speed
 * that defeats the purpose. `process.arch === "arm64" && platform === "darwin"`.
 */
export function isAppleSilicon(): boolean {
	return process.platform === "darwin" && process.arch === "arm64";
}

/** `ELIZA_LOCAL_MLX=1` (the explicit opt-in — historically the spawn opt-in). */
export function mlxOptIn(): boolean {
	return (
		envFlag("ELIZA_LOCAL_MLX") ||
		process.env.ELIZA_LOCAL_BACKEND?.trim().toLowerCase() === MLX_BACKEND_ID
	);
}

/**
 * Resolve a Python interpreter that has `mlx-lm` available. Retained for
 * diagnostics only — local inference no longer launches a Python subprocess.
 * Returns null when no interpreter can `import mlx_lm`.
 */
export function resolveMlxPython(): string | null {
	const candidates = [
		process.env.ELIZA_MLX_PYTHON,
		process.env.ELIZA_PYTHON,
		"python3",
		"python",
	].filter((c): c is string => !!c && c.trim().length > 0);
	for (const py of candidates) {
		try {
			const probe = spawnSync(
				py,
				["-c", "import mlx_lm, mlx.core; print(mlx_lm.__version__)"],
				{ encoding: "utf8", timeout: 8000 },
			);
			if (probe.status === 0 && /\d/.test(probe.stdout)) {
				return py;
			}
		} catch {
			// try next
		}
	}
	return null;
}

/**
 * Heuristic: is `dir` an MLX-format model snapshot? An MLX model is an HF
 * directory layout — `config.json` plus weights (`*.safetensors`) — that was
 * converted by `mlx_lm.convert`. We accept a dir with `config.json` + at least
 * one `.safetensors` file. (We deliberately do NOT accept a `.gguf` — that's
 * the llama.cpp path.)
 */
export function looksLikeMlxModelDir(dir: string): boolean {
	try {
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
		if (!fs.existsSync(path.join(dir, "config.json"))) return false;
		const entries = fs.readdirSync(dir);
		return entries.some((e) => e.endsWith(".safetensors"));
	} catch {
		return false;
	}
}

/**
 * Locate a user-configured MLX eliza-1 text model. Diagnostic helper.
 */
export function resolveMlxModelDir(): string | null {
	const explicit = process.env.ELIZA_MLX_MODEL_DIR?.trim();
	if (explicit && looksLikeMlxModelDir(explicit)) return explicit;
	const stateDir =
		process.env.ELIZA_STATE_DIR ||
		process.env.MILADY_STATE_DIR ||
		path.join(os.homedir(), ".milady");
	const mlxRoot = path.join(stateDir, "local-inference", "mlx");
	try {
		if (fs.existsSync(mlxRoot)) {
			for (const name of fs.readdirSync(mlxRoot)) {
				if (!name.startsWith("eliza-1")) continue;
				const cand = path.join(mlxRoot, name);
				if (looksLikeMlxModelDir(cand)) return cand;
			}
		}
	} catch {
		// fall through
	}
	return null;
}

/**
 * Eligibility for engine routing. With the in-process MLX binding not yet
 * available in this repo, this always reports `eligible: false` even when the
 * environment looks otherwise ready, and the reason cites the missing runtime.
 * Kept callable so the diagnostics surface stays consistent across builds.
 */
export function mlxBackendEligible(): {
	eligible: boolean;
	reason: string;
	python: string | null;
	modelDir: string | null;
} {
	if (!mlxOptIn()) {
		return {
			eligible: false,
			reason: "ELIZA_LOCAL_MLX not set (convenience path is opt-in)",
			python: null,
			modelDir: null,
		};
	}
	if (!isAppleSilicon()) {
		return {
			eligible: false,
			reason: "not Apple Silicon (MLX is Metal-only)",
			python: null,
			modelDir: null,
		};
	}
	// No in-process MLX runtime exists in this repo today, so eligibility is
	// `false` regardless of what `resolveMlxPython()` / `resolveMlxModelDir()`
	// would report. The python probe is intentionally skipped here because it
	// spawns `python3` and can be slow on hosts without it; callers that want
	// those diagnostic fields can invoke the helpers directly.
	return {
		eligible: false,
		reason:
			"no in-process MLX runtime: this repo currently has no node-mlx / mlx-c binding and `libelizainference` is built without an MLX backend. The previous spawn+HTTP path has been removed (local inference must stay in-process). See plugins/plugin-local-inference/MLX_IN_PROCESS_PLAN.md.",
		python: null,
		modelDir: null,
	};
}

interface MlxServerStatus {
	running: false;
	baseUrl: null;
	modelDir: null;
	pid: null;
}

/**
 * Compatibility stub. The in-process MLX runtime is not yet wired up
 * (see header / `plugins/plugin-local-inference/MLX_IN_PROCESS_PLAN.md`). All operational
 * methods throw or report "not loaded"; `hasLoadedModel()` is permanently
 * `false`, which preserves the engine's existing fallthrough at the MLX
 * branch (the spawn-based runtime was never actually invoked from production
 * code, so this matches the observable runtime behavior).
 */
export class MlxLocalServer {
	status(): MlxServerStatus {
		return { running: false, baseUrl: null, modelDir: null, pid: null };
	}

	hasLoadedModel(): boolean {
		return false;
	}

	currentModelPath(): string | null {
		return null;
	}

	async load(_opts: {
		python?: string;
		modelDir: string;
		host?: string;
		port?: number;
		extraArgs?: string[];
		healthTimeoutMs?: number;
	}): Promise<void> {
		throw new Error(
			"[mlx] in-process MLX runtime is not implemented. The previous spawn+HTTP transport has been removed because local inference must stay in-process; see plugins/plugin-local-inference/MLX_IN_PROCESS_PLAN.md for the blocker (no node-mlx/mlx-c binding in this repo today) and the concrete unblock plan.",
		);
	}

	async unload(): Promise<void> {
		// Nothing to tear down — kept so callers (and tests) can drive a
		// load/unload lifecycle without branching on backend.
	}

	async generate(_args: GenerateArgs): Promise<string> {
		throw new Error(
			"[mlx] generate() called with no in-process MLX runtime. See plugins/plugin-local-inference/MLX_IN_PROCESS_PLAN.md.",
		);
	}
}

/** Process-wide singleton (mirrors `dflashLlamaServer`). */
export const mlxLocalServer = new MlxLocalServer();
