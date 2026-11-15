/**
 * AOSP / generic-FFI path, ABI, and env-resolution helpers for the
 * local-inference bootstrap.
 *
 * These are pure (no `bun:ffi`, no native dlopen) helpers shared by
 * `aosp-local-inference-bootstrap.ts` and the package barrel. The fused
 * `libelizainference.so` loader is the SOLE text/voice native library on
 * AOSP; this module resolves the per-ABI asset directory that library lives
 * in plus the activation gate.
 */

import path from "node:path";

/**
 * The fused FFI loader is enabled by `ELIZA_LOCAL_LLAMA=1` — the canonical
 * AOSP / mobile opt-in, set by `ElizaAgentService.java` before spawning the
 * bun agent. `ELIZA_DISABLE_FFI_LLAMA=1` forces a hard opt-out.
 */
export function isAospEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ELIZA_DISABLE_FFI_LLAMA?.trim() === "1") return false;
  return env.ELIZA_LOCAL_LLAMA?.trim() === "1";
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

/**
 * Resolve the per-ABI native asset directory for the current ABI. The AOSP
 * agent process runs with `cwd = <agent_root>`; the Java side unpacks
 * `agent/{abi}/libelizainference.so` (and siblings) alongside the bun runtime.
 * `{abi}` is `arm64-v8a` (arm64) or `x86_64` (x64).
 *
 * Exported for unit tests so we can verify ABI mapping without dlopen.
 */
export function resolveAospAbiDir(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  const abiDir =
    arch === "arm64" ? "arm64-v8a" : arch === "x64" ? "x86_64" : null;
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
