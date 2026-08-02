/**
 * AOSP / generic-FFI path, ABI, and env-resolution helpers for the
 * local-inference bootstrap.
 *
 * These are pure (no `bun:ffi`, no native dlopen) helpers shared by
 * `aosp-local-inference-bootstrap.ts` and the package barrel. The fused
 * `libelizainference.so` loader is the SOLE text/voice native library on
 * AOSP; this module resolves the per-ABI asset directory that library lives
 * in plus the activation gate and output-budget tunables.
 */

import path from "node:path";

/**
 * The fused FFI loader is enabled when ANY of these signals fires:
 *
 *   1. `ELIZA_LOCAL_LLAMA=1` — the canonical AOSP / mobile opt-in. Set by
 *      `ElizaAgentService.java` before spawning the bun agent.
 *   2. `process.arch === "riscv64"` — there is no riscv64 NAPI prebuild, so
 *      the in-process FFI loader (dlopening the vendored `.so`) is the only
 *      viable local path. Auto-firing keeps the riscv64 boot zero-config.
 *
 * `ELIZA_DISABLE_FFI_LLAMA=1` forces a hard opt-out.
 */
export function isAospEnabled(
  env: NodeJS.ProcessEnv = process.env,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  if (env.ELIZA_DISABLE_FFI_LLAMA?.trim() === "1") return false;
  if (env.ELIZA_LOCAL_LLAMA?.trim() === "1") return true;
  if (arch === "riscv64") return true;
  return false;
}

/**
 * Read a non-negative integer env override, falling back to `fallback` when
 * the variable is unset, blank, or not parseable. Negative values clamp to
 * the fallback.
 */
function readEnvInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function firstSentenceEndIndex(text: string, minChars = 12): number {
  const minEnd = Math.max(1, minChars);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (i + 1 < minEnd) continue;
    const prev = i > 0 ? text[i - 1] : "";
    const next = i + 1 < text.length ? text[i + 1] : "";
    if (/\d/.test(prev) && /\d/.test(next)) continue;
    // Streaming chunks can end between a decimal point and the next digit
    // ("0." now, "8B" in the next callback). Wait for more text instead
    // of ending the sentence on a partial decimal token.
    if (ch === "." && /\d/.test(prev) && next === "") continue;
    return i + 1;
  }
  return -1;
}

export function resolveAospGenerateTokenBudget(options: {
  requestedMaxTokens?: number;
  nCtx: number;
  nBatch: number;
  env?: NodeJS.ProcessEnv;
}): {
  requestedMaxTokens: number;
  maxTokens: number;
  maxOutputReserve: number;
  contextCap: number;
  envCap: number | null;
  capped: boolean;
} {
  const env = options.env ?? process.env;
  const defaultMaxTokens = readEnvInt(
    "ELIZA_LLAMA_DEFAULT_MAX_TOKENS",
    512,
    env,
  );
  const requested =
    Number.isFinite(options.requestedMaxTokens) &&
    options.requestedMaxTokens != null &&
    options.requestedMaxTokens > 0
      ? Math.floor(options.requestedMaxTokens)
      : defaultMaxTokens;
  // Never let an oversized caller budget reserve the whole context. On
  // Android a generic TEXT_LARGE call can arrive with maxTokens=8192 while
  // n_ctx=4096; without this clamp the prompt capacity collapses to 1 token
  // and the phone spends minutes decoding an irrelevant tail.
  const usableContext = Math.max(1, options.nCtx - options.nBatch);
  const contextCap = Math.max(1, Math.floor(usableContext / 2));
  const envCapRaw = readEnvInt("ELIZA_LLAMA_MAX_OUTPUT_TOKENS", 256, env);
  const envCap = envCapRaw > 0 ? Math.min(envCapRaw, contextCap) : null;
  const cap = envCap ?? contextCap;
  const maxTokens = Math.max(1, Math.min(requested, cap));
  return {
    requestedMaxTokens: requested,
    maxTokens,
    maxOutputReserve: maxTokens,
    contextCap,
    envCap,
    capped: maxTokens !== requested,
  };
}

/**
 * Resolve the per-ABI native asset directory for the current ABI. The AOSP
 * agent process runs with `cwd = <agent_root>`; the Java side unpacks
 * `agent/{abi}/libelizainference.so` (and siblings) alongside the bun runtime.
 * `{abi}` is `arm64-v8a` (arm64), `x86_64` (x64), or `riscv64`.
 *
 * Exported for unit tests so we can verify ABI mapping without dlopen.
 */
export function resolveAospAbiDir(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  const abiDir =
    arch === "arm64"
      ? "arm64-v8a"
      : arch === "x64"
        ? "x86_64"
        : arch === "riscv64"
          ? "riscv64"
          : null;
  if (abiDir === null) {
    throw new Error(
      `[aosp-llama] Unsupported process.arch for AOSP build: ${arch}`,
    );
  }
  return path.join(cwd, abiDir);
}

/**
 * Resolve the fused `libelizainference.so` path for the current ABI — the
 * SOLE native text/voice library on AOSP.
 *
 * Exported for unit tests so we can verify ABI mapping without dlopen.
 */
export function resolveAospElizaInferenceLibPath(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  return path.join(resolveAospAbiDir(arch, cwd), "libelizainference.so");
}
