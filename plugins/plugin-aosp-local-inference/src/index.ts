/**
 * @elizaos/plugin-aosp-local-inference
 *
 * AOSP-only fused-`libelizainference` FFI bootstrap that wires
 * `TEXT_SMALL` / `TEXT_LARGE` / `TEXT_EMBEDDING` / `TEXT_TO_SPEECH` /
 * `TRANSCRIPTION` model handlers backed by the single fused native library
 * (streaming-LLM text + MTP + KV-quant + TTS/ASR). There is no separate
 * libllama text runtime — the fused lib is the sole text/voice backend.
 *
 * The exports here are imported (statically, to defeat tree-shaking on
 * `Bun.build`) by `@elizaos/agent`'s mobile entrypoint, and dynamically by
 * the local-inference handler in `@elizaos/app-core`.
 *
 * The modules self-gate on `ELIZA_LOCAL_LLAMA=1` and are no-ops on every
 * other platform/runtime, so they are safe to import unconditionally.
 */

export {
  firstSentenceEndIndex,
  isAospEnabled,
  resolveAospAbiDir,
  resolveAospElizaInferenceLibPath,
  resolveAospGenerateTokenBudget,
} from "./aosp-llama-paths.js";

export {
  activateAospLocalInferenceModel,
  buildAospLoadModelArgs,
  clearAospLocalInferenceModel,
  ensureAospLocalInferenceHandlers,
  registerAospLlamaLoader,
  tryBuildAospFusedTextLoader,
} from "./aosp-local-inference-bootstrap.js";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import {
  firstSentenceEndIndex as _bs_1_firstSentenceEndIndex,
  isAospEnabled as _bs_2_isAospEnabled,
  resolveAospAbiDir as _bs_3_resolveAospAbiDir,
  resolveAospElizaInferenceLibPath as _bs_4_resolveAospElizaInferenceLibPath,
  resolveAospGenerateTokenBudget as _bs_5_resolveAospGenerateTokenBudget,
} from "./aosp-llama-paths.js";
import {
  activateAospLocalInferenceModel as _bs_6_activateAospLocalInferenceModel,
  buildAospLoadModelArgs as _bs_7_buildAospLoadModelArgs,
  clearAospLocalInferenceModel as _bs_8_clearAospLocalInferenceModel,
  ensureAospLocalInferenceHandlers as _bs_9_ensureAospLocalInferenceHandlers,
  registerAospLlamaLoader as _bs_10_registerAospLlamaLoader,
  tryBuildAospFusedTextLoader as _bs_11_tryBuildAospFusedTextLoader,
} from "./aosp-local-inference-bootstrap.js";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__ = [
  _bs_1_firstSentenceEndIndex,
  _bs_2_isAospEnabled,
  _bs_3_resolveAospAbiDir,
  _bs_4_resolveAospElizaInferenceLibPath,
  _bs_5_resolveAospGenerateTokenBudget,
  _bs_6_activateAospLocalInferenceModel,
  _bs_7_buildAospLoadModelArgs,
  _bs_8_clearAospLocalInferenceModel,
  _bs_9_ensureAospLocalInferenceHandlers,
  _bs_10_registerAospLlamaLoader,
  _bs_11_tryBuildAospFusedTextLoader,
];
const bundleSafetyGlobal = globalThis as typeof globalThis & {
  __bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__?: typeof __bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__;
};
bundleSafetyGlobal.__bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__ =
  __bundle_safety_PLUGINS_PLUGIN_AOSP_LOCAL_INFERENCE_SRC_INDEX__;
