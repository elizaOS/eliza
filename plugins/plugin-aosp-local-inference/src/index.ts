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

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { __resetForTests as _bs_1___resetForTests, kvCacheTypeNameToEnum as _bs_2_kvCacheTypeNameToEnum, readEnvKvCacheType as _bs_3_readEnvKvCacheType, registerAospLlamaLoader as _bs_4_registerAospLlamaLoader, resolveKvCacheType as _bs_5_resolveKvCacheType, resolveLibllamaPath as _bs_6_resolveLibllamaPath, resolveLlamaShimPath as _bs_7_resolveLlamaShimPath, resolveThreads as _bs_8_resolveThreads } from "./aosp-llama-adapter.js";
import { ensureAospLocalInferenceHandlers as _bs_10_ensureAospLocalInferenceHandlers } from "./aosp-local-inference-bootstrap.js";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__ = [_bs_1___resetForTests, _bs_2_kvCacheTypeNameToEnum, _bs_3_readEnvKvCacheType, _bs_4_registerAospLlamaLoader, _bs_5_resolveKvCacheType, _bs_6_resolveLibllamaPath, _bs_7_resolveLlamaShimPath, _bs_8_resolveThreads, _bs_10_ensureAospLocalInferenceHandlers];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__ = __bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__;
