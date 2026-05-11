export * from "./types";
export { PhraseChunker, chunkTokens } from "./phrase-chunker";
export { RollbackQueue, type RollbackEvent } from "./rollback-queue";
export {
  BargeInController,
  type BargeInListener,
  type CancelSignal,
} from "./barge-in";
export { PcmRingBuffer, InMemoryAudioSink } from "./ring-buffer";
export {
  SpeakerPresetCache,
  type PresetBundlePaths,
  type LoadedPresetBundle,
} from "./speaker-preset-cache";
export {
  VOICE_PRESET_MAGIC,
  VOICE_PRESET_VERSION,
  VOICE_PRESET_HEADER_BYTES,
  VoicePresetFormatError,
  readVoicePresetFile,
  writeVoicePresetFile,
  type VoicePresetFile,
  type VoicePresetSeedPhrase,
} from "./voice-preset-format";
export {
  CharacterPhonemeStub,
  type Phoneme,
  type PhonemeTokenizer,
} from "./phoneme-tokenizer";
export {
  PhraseCache,
  canonicalizePhraseText,
  type CachedPhraseAudio,
} from "./phrase-cache";
export {
  VoiceScheduler,
  type SchedulerEvents,
  type SchedulerDeps,
} from "./scheduler";
export {
  EngineVoiceBridge,
  StubOmniVoiceBackend,
  FfiOmniVoiceBackend,
  VoiceStartupError,
  decodeMonoPcm16Wav,
  encodeMonoPcm16Wav,
  type EngineVoiceBridgeOptions,
} from "./engine-bridge";
export {
  SharedResourceRegistry,
  type DflashDrafterHandle,
  type KernelSet,
  type MmapRegionHandle,
  type RefCountedResource,
  type SchedulerSlot,
  type SharedTokenizer,
} from "./shared-resources";
export {
  VoiceLifecycle,
  VoiceLifecycleError,
  type ArmedResources,
  type TextResources,
  type VoiceLifecycleEvents,
  type VoiceLifecycleLoaders,
  type VoiceLifecycleState,
} from "./lifecycle";

/**
 * Voice on/off invariants (binding for every consumer of this module):
 *
 * 1. Voice is OFF by default — text + drafter only. TTS, ASR, the
 *    speaker preset cache, the phrase cache, the chunker, the
 *    rollback queue, the barge-in controller, and the ring buffer
 *    are NOT in RAM until `VoiceLifecycle.arm()` is called.
 *
 * 2. Shared resources between text and voice (one instance each per
 *    engine, refcounted by `SharedResourceRegistry`):
 *      - tokenizer (Eliza-1/OmniVoice share a vocabulary)
 *      - mmap regions for weights (deduplicated by absolute path)
 *      - the fused kernel set (TurboQuant/QJL/Polar live in the
 *        same shipped llama.cpp library after the fusion build)
 *      - the scheduler queue (one queue, prioritised across surfaces)
 *      - the DFlash drafter (always wired — see AGENTS.md §3 #4)
 *
 *    Text and voice keep SEPARATE KV caches (different layer counts,
 *    different head configs, different quantizations — AGENTS.md §4
 *    "shared KV cache scheduling, not shared KV memory").
 *
 * 3. `arm()` lazily loads TTS + ASR via mmap; `disarm()` issues a real
 *    page-eviction call (`madvise(MADV_DONTNEED)` on Linux/Android,
 *    `madvise(MADV_FREE_REUSABLE)` on Apple, `VirtualUnlock` +
 *    `OfferVirtualMemory` on Windows). The speaker preset and phrase
 *    cache stay in a small LRU after disarm — they're KB-scale.
 *
 * 4. Hardware-resource exhaustion (RAM pressure, OS page eviction
 *    refusal, mmap fail, kernel missing) MUST surface as a
 *    `VoiceLifecycleError` with a structured `code`. There is NO
 *    silent fallback to text-only and NO automatic downgrade to a
 *    smaller voice model — see AGENTS.md §3.
 *
 * 5. Illegal lifecycle transitions throw `VoiceLifecycleError` with
 *    code `"illegal-transition"`. The state is a discriminated
 *    union, never a string.
 */
