/**
 * Engine-backed `verifyOnDevice` hook for the Eliza-1 downloader
 * (`packages/inference/AGENTS.md` §7): after a bundle is materialized and
 * every file's sha256 checks out, run one cold smoke pass —
 *
 *   load → 1-token text generation → (if the bundle ships voice assets)
 *   1-phrase voice generation → barge-in cancel → unload
 *
 * — before the bundle is allowed to auto-fill an empty default slot. The
 * downloader stays decoupled from the engine: it only knows the
 * {@link VerifyBundleOnDevice} shape; this module is the concrete
 * implementation the service layer injects.
 *
 * Failure semantics: any error throws. The downloader catches it and leaves
 * `bundleVerifiedAt` unset, so an unverified bundle is registered but does
 * not become the recommended default. There is no "verified anyway" path —
 * voice is mandatory for Eliza-1 voice tiers (AGENTS.md §3), so a bundle
 * whose fused voice ABI is not loadable on this device legitimately fails
 * verify until the fused build is present.
 */

import fs from "node:fs/promises";
import type { VerifyBundleOnDevice } from "./downloader";
import { localInferenceEngine } from "./engine";
import { parseManifestOrThrow } from "./manifest";

/** A short, deterministic prompt — we only care that one token comes back. */
const VERIFY_PROMPT = "Reply with one word.";
/** A short phrase to drive a single TTS dispatch through the voice scheduler. */
const VERIFY_PHRASE = "Ready.";

async function manifestDeclaresVoice(manifestPath: string): Promise<boolean> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = parseManifestOrThrow(JSON.parse(raw));
  // Voice tiers ship a TTS GGUF under `files.voice`; the ASR/VAD files are
  // gated on top of that. If there is no voice file, this is a text-only
  // bundle and the voice leg of the smoke is skipped.
  return (manifest.files.voice ?? []).length > 0;
}

async function verifyText(textGgufPath: string): Promise<void> {
  await localInferenceEngine.load(textGgufPath);
  const out = await localInferenceEngine.generate({
    prompt: VERIFY_PROMPT,
    maxTokens: 1,
    temperature: 0,
  });
  if (typeof out !== "string") {
    throw new Error(
      `[verify-on-device] text generation returned ${typeof out}, expected string`,
    );
  }
}

async function verifyVoice(bundleRoot: string): Promise<void> {
  // `useFfiBackend: true` is the production path — it loads the fused
  // `libelizainference` and hard-fails (`VoiceStartupError`) when the fused
  // build is absent. That is the intended behaviour: a voice bundle that
  // cannot run voice on this device is not verified.
  localInferenceEngine.startVoice({ bundleRoot, useFfiBackend: true });
  try {
    await localInferenceEngine.armVoice();
    // One real synthesis through the voice bridge.
    const pcm = await localInferenceEngine.synthesizeSpeech(VERIFY_PHRASE);
    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0) {
      throw new Error(
        "[verify-on-device] voice synthesis produced no PCM bytes",
      );
    }
    // Barge-in cancel must be accepted without throwing — exercises the
    // hard-stop path the voice loop uses to abort speculative TTS.
    localInferenceEngine.triggerBargeIn();
  } finally {
    await localInferenceEngine.stopVoice();
  }
}

export const verifyBundleOnDevice: VerifyBundleOnDevice = async ({
  bundleRoot,
  manifestPath,
  textGgufPath,
}) => {
  try {
    await verifyText(textGgufPath);
    if (await manifestDeclaresVoice(manifestPath)) {
      await verifyVoice(bundleRoot);
    }
  } finally {
    // Always release the model the verify pass loaded — the bundle is not
    // "active" yet, and the active-model coordinator owns load/unload from
    // here on.
    await localInferenceEngine.unload().catch(() => {});
  }
};
