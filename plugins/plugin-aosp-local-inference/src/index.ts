/**
 * @elizaos/plugin-aosp-local-inference
 *
 * AOSP-only llama.cpp FFI bindings (via `bun:ffi`) and the local-inference
 * bootstrap that wires `TEXT_SMALL` / `TEXT_LARGE` / `TEXT_EMBEDDING` model
 * handlers backed by the AOSP llama loader.
 *
 * The two exports here are imported (statically, to defeat tree-shaking on
 * `Bun.build`) by `@elizaos/agent`'s mobile entrypoint, and dynamically by
 * the local-inference handler in `@elizaos/app-core`.
 *
 * Both modules self-gate on `ELIZA_LOCAL_LLAMA=1` and are no-ops on every
 * other platform/runtime, so they are safe to import unconditionally.
 */

export {
  __resetForTests,
  kvCacheTypeNameToEnum,
  looksLikeBonsai,
  readEnvKvCacheType,
  registerAospLlamaLoader,
  resolveKvCacheType,
  resolveLibllamaPath,
  resolveLlamaShimPath,
  resolveThreads,
} from "./aosp-llama-adapter.js";
export type {
  AospLlamaLoadOptions,
  KvCacheTypeName,
} from "./aosp-llama-adapter.js";

export { ensureAospLocalInferenceHandlers } from "./aosp-local-inference-bootstrap.js";
