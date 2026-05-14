#pragma once
// kokoro-file-picker.h: Kokoro-side of the eliza-inference-ffi.cpp voice
// dispatch.
//
// The fused libelizainference picks one of {OmniVoice, Kokoro} per bundle
// at engine arm time. OmniVoice ships under `tts/omnivoice-base-*.gguf` +
// `tts/omnivoice-tokenizer-*.gguf`; Kokoro ships under `tts/kokoro/*.gguf`
// alongside the legacy `tts/kokoro/model_q4.onnx` (kept for backward
// compatibility with bundles that pre-date the GGUF port).
//
// Discovery contract (mirrors `eliza_pick_voice_files` in
// eliza-inference-ffi.cpp, returns true on success and populates the
// outparam strings):
//
//   bool eliza_pick_kokoro_files(
//       const std::filesystem::path & bundle_dir,
//       std::string & gguf_path,           // absolute path to the model GGUF
//       std::string & voices_dir,          // absolute path to voices/
//       std::string & default_voice_id);   // e.g. "af_bella"
//
// The full dispatch order in eliza_load_tts() should be:
//
//   1. If `bundle_dir/tts/kokoro/*.gguf` exists -> Kokoro (preferred when
//      both backends ship; see catalog.ts ELIZA_1_VOICE_BACKENDS).
//   2. Else if `bundle_dir/tts/omnivoice-*.gguf` exists -> OmniVoice.
//   3. Else -> ELIZA_ERR_BUNDLE_INVALID.
//
// The TS-side runtime selector (`runtime-selection.ts`) makes the same
// preference visible to the JS scheduler so both sides agree.

#include "ov-error.h"

#include <filesystem>
#include <string>

// Probe `bundle_dir` for a Kokoro GGUF + voices directory. Returns false
// when any required piece is missing (no GGUF, empty voices dir, no
// readable default voice). Does NOT log on miss - callers cascade to the
// next backend.
bool eliza_pick_kokoro_files(const std::filesystem::path & bundle_dir,
                             std::string & gguf_path,
                             std::string & voices_dir,
                             std::string & default_voice_id);

// Helper: true iff `bundle_dir/tts/kokoro/<file>.gguf` exists for any
// file. Used by the dispatcher to choose Kokoro before falling through
// to OmniVoice. Cheaper than the full picker.
bool eliza_bundle_has_kokoro_gguf(const std::filesystem::path & bundle_dir);
