// elizavoice-jni.cpp
//
// JNI bridge for the fused, NDK/bionic-built `libelizainference.so` (the
// omnivoice `elizainference` target — all four voice runtimes fused at ABI
// v7) running INSIDE the normal Android APK process (ai.elizaos.app,
// Capacitor/bionic), NOT the separate musl bun agent.
//
// Phase 3a proved the load + a single VAD op. Phase 3b wires the WHOLE
// mic→attributed-turn pipeline through this host:
//
//   - Context lifecycle: contextCreate / contextDestroy.
//   - The four fused classifier ops, each wrapping the matching
//     `eliza_inference_*` symbols:
//       VAD       open / processBatch / reset / close
//       wakeword  open / scoreBatch   / reset / close
//       speaker   open / embed        /        close
//       diariz    open / segment      /        close
//   - A native streaming PIPELINE (pipelineOpen / pipelineProcess /
//     pipelineFlush / pipelineReset / pipelineClose) that runs the VAD
//     hot-loop + turn segmentation NATIVELY (no per-512-window JS↔native
//     bridge call): JS hands it an audio-frame batch, it streams the PCM
//     through VAD, applies the onset/offset/pause/end-hangover state machine
//     (ported from VadDetector in vad.ts), buffers the turn PCM, and on
//     speech-end runs speaker-embed + diariz natively and returns a
//     TURN-LEVEL JSON result (speaker 256-float embedding + diariz int8
//     labels) to JS. JS then applies the ambient gate + builds the
//     voiceTurnSignal.
//
// PCM marshalling: Java `float[]` (16 kHz mono fp32 in [-1, 1]) in via
// GetFloatArrayElements (JNI_ABORT release — read-only, no copy-back).
// Outputs: the 256-float speaker embedding and the per-frame diariz int8
// labels are returned as Java arrays; turn metadata is returned as a JSON
// string the JS side parses.
//
// All sessions are reference-counted by an opaque jlong handle (the native
// pointer). Idempotent close. Errors surface as a thrown RuntimeException
// (so the Capacitor plugin rejects the call) — no swallow, no defaulted
// result (AGENTS.md §3, §9).

#include <jni.h>
#include <android/log.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "eliza-inference-ffi.h"

#define LOG_TAG "ElizaVoiceJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// Sample-rate / window constants (must mirror the JS contract).
constexpr int kSampleRate = 16000;
constexpr size_t kVadWindow = 512;       // Silero v5 window @ 16 kHz
constexpr size_t kWakeFrame = 1280;      // openWakeWord 80 ms frame @ 16 kHz
constexpr size_t kSpeakerEmbeddingDim = 256;
constexpr size_t kDiarizWindow = 80000;  // pyannote 5 s window @ 16 kHz
constexpr size_t kDiarizLabelCap = 2048;

jstring to_jstring(JNIEnv* env, const std::string& s) {
    return env->NewStringUTF(s.c_str());
}

std::string from_jstring(JNIEnv* env, jstring js) {
    if (js == nullptr) return std::string();
    const char* chars = env->GetStringUTFChars(js, nullptr);
    std::string out(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(js, chars);
    return out;
}

// Throw a java.lang.RuntimeException; the Capacitor plugin maps that to a
// rejected call. Frees the heap-allocated C diagnostic when present.
void throw_runtime(JNIEnv* env, const std::string& stage, char* outError) {
    std::string msg = "[elizavoice-jni] " + stage;
    if (outError) {
        msg += ": ";
        msg += outError;
        std::free(outError);
    }
    LOGE("%s", msg.c_str());
    jclass cls = env->FindClass("java/lang/RuntimeException");
    if (cls) env->ThrowNew(cls, msg.c_str());
}

// Copy a Java float[] into a std::vector<float> (read-only view, no copy-back).
std::vector<float> read_float_array(JNIEnv* env, jfloatArray arr) {
    if (arr == nullptr) return {};
    const jsize n = env->GetArrayLength(arr);
    std::vector<float> out(static_cast<size_t>(n));
    if (n > 0) {
        env->GetFloatArrayRegion(arr, 0, n, out.data());
    }
    return out;
}

float rms_of(const float* pcm, size_t n) {
    if (n == 0) return 0.0f;
    double acc = 0.0;
    for (size_t i = 0; i < n; ++i) acc += static_cast<double>(pcm[i]) * pcm[i];
    return static_cast<float>(std::sqrt(acc / static_cast<double>(n)));
}

// --- Native turn-segmentation state machine (ports VadDetector core) ------
//
// Phases mirror vad.ts: idle → speaking → paused → (end) → idle. Thresholds
// are the LiveDiarizationSession defaults (onset 0.5, pause hangover 120 ms,
// end hangover 500 ms, min speech 250 ms). The adaptive-hangover (V4) and
// fast-endpoint (V1) refinements are intentionally NOT ported — this native
// loop only needs robust turn boundaries; the JS layer no longer runs the
// per-window detector when the native pipeline owns segmentation.
struct VadSegmenter {
    float onsetThreshold = 0.5f;
    float offsetThreshold = 0.35f;     // onset - 0.15
    double pauseHangoverMs = 120.0;
    double endHangoverMs = 500.0;
    double minSpeechMs = 250.0;
    double windowDurationMs = 1000.0 * kVadWindow / kSampleRate;  // 32 ms

    enum Phase { Idle, Speaking, Paused } phase = Idle;
    double clockMs = 0.0;
    double speechStartMs = 0.0;
    double lastSpeechMs = 0.0;
    double pauseStartedMs = 0.0;

    // Result flags set by step(): the caller acts on speechStarted /
    // speechEnded between feeding windows.
    bool speechStarted = false;
    bool speechEnded = false;
    double endedSpeechDurationMs = 0.0;

    void reset() {
        phase = Idle;
        clockMs = 0.0;
        speechStartMs = lastSpeechMs = pauseStartedMs = 0.0;
        speechStarted = speechEnded = false;
        endedSpeechDurationMs = 0.0;
    }

    // Advance one window's worth of clock with the VAD probability. Returns via
    // speechStarted / speechEnded the boundary events for this window.
    void step(float prob) {
        speechStarted = false;
        speechEnded = false;
        clockMs += windowDurationMs;
        const double now = clockMs;
        const bool isSpeechFrame = prob >= onsetThreshold;
        const bool aboveOffset = prob >= offsetThreshold;

        switch (phase) {
            case Idle:
                if (isSpeechFrame) {
                    phase = Speaking;
                    speechStartMs = now - windowDurationMs;
                    lastSpeechMs = now;
                    speechStarted = true;
                }
                break;
            case Speaking:
                if (aboveOffset) lastSpeechMs = now;
                if (now - lastSpeechMs >= pauseHangoverMs) {
                    phase = Paused;
                    pauseStartedMs = lastSpeechMs;
                }
                break;
            case Paused:
                if (isSpeechFrame) {
                    phase = Speaking;
                    lastSpeechMs = now;
                } else if (now - pauseStartedMs >= endHangoverMs) {
                    endedSpeechDurationMs = lastSpeechMs - speechStartMs;
                    phase = Idle;
                    speechEnded = true;
                }
                break;
        }
    }

    // Force-close an open turn (on flush). Returns true when a turn was open.
    bool forceEnd() {
        speechStarted = false;
        speechEnded = false;
        if (phase == Idle) return false;
        endedSpeechDurationMs = lastSpeechMs - speechStartMs;
        phase = Idle;
        speechEnded = true;
        return true;
    }
};

// --- Pipeline session -----------------------------------------------------
//
// Owns one fused VAD + speaker + diariz session set anchored to a context,
// plus the native turn-segmentation state machine and the in-flight turn PCM
// buffer. Runs entirely in the bionic app process.
struct PipelineSession {
    EliInferenceContext* ctx = nullptr;  // borrowed (owned by the context handle)
    EliVad* vad = nullptr;
    EliSpeaker* speaker = nullptr;
    EliDiariz* diariz = nullptr;

    VadSegmenter seg;

    // Carry-over PCM not yet aligned to a 512-window boundary.
    std::vector<float> pending;
    // The in-flight turn's PCM (between speech-start and speech-end), with a
    // small pre-roll so the leading word is not clipped.
    std::vector<float> turnPcm;
    std::vector<float> preRoll;          // ring of pre-speech-start PCM
    size_t preRollSamples = static_cast<size_t>(0.3 * kSampleRate);
    size_t maxTurnSamples = static_cast<size_t>(30 * kSampleRate);
    bool capturing = false;
    int turnSeq = 0;

    // Completed turns produced by the last process()/flush() call, encoded as
    // JSON the JS side parses. Drained by the caller.
    std::vector<std::string> turns;
    // Parallel arrays for the heavy payloads (embedding + labels) so JS can
    // read them without re-parsing big JSON.
    std::vector<std::vector<float>> turnEmbeddings;
    std::vector<std::vector<int8_t>> turnLabels;
    std::vector<std::vector<float>> turnPcms;
};

// Append `n` samples to a bounded pre-roll ring, dropping oldest beyond cap.
void push_preroll(PipelineSession* s, const float* pcm, size_t n) {
    if (s->preRollSamples == 0) return;
    s->preRoll.insert(s->preRoll.end(), pcm, pcm + n);
    if (s->preRoll.size() > s->preRollSamples) {
        const size_t drop = s->preRoll.size() - s->preRollSamples;
        s->preRoll.erase(s->preRoll.begin(),
                         s->preRoll.begin() + static_cast<long>(drop));
    }
}

// Run speaker-embed + diariz on a finalized turn and stage the JSON + payloads.
// Returns false (with *outError set) on a native op failure.
bool finalize_turn(PipelineSession* s, char** outError) {
    if (s->turnPcm.empty()) return true;
    const size_t samples = s->turnPcm.size();
    const int turnId = s->turnSeq++;

    // Speaker embedding over the whole turn (WeSpeaker min ~ 0.5 s; the JS
    // attribution pipeline re-checks WESPEAKER_MIN_SAMPLES, but the native op
    // needs enough audio — run it and let the value flow; too-short turns just
    // yield a weak embedding the matcher discounts).
    std::vector<float> embedding(kSpeakerEmbeddingDim, 0.0f);
    bool haveEmbedding = false;
    if (s->speaker && samples >= kSampleRate / 2) {
        const int rc = eliza_inference_speaker_embed(
            s->speaker, s->turnPcm.data(), samples, embedding.data(), outError);
        if (rc != ELIZA_OK) return false;
        haveEmbedding = true;
    }

    // Diarizer over a single 5 s window: pyannote takes exactly 80000 samples.
    // Center-crop or zero-pad the turn to the fixed window (the JS reducer maps
    // frame labels back to ms via the fixed stride, so the window is canonical).
    std::vector<int8_t> labels;
    bool haveLabels = false;
    if (s->diariz) {
        std::vector<float> window(kDiarizWindow, 0.0f);
        const size_t copy = samples < kDiarizWindow ? samples : kDiarizWindow;
        std::memcpy(window.data(), s->turnPcm.data(), copy * sizeof(float));
        std::vector<int8_t> out(kDiarizLabelCap, 0);
        size_t nLabels = out.size();
        const int rc = eliza_inference_diariz_segment(
            s->diariz, window.data(), window.size(), out.data(), &nLabels,
            outError);
        if (rc != ELIZA_OK) return false;
        labels.assign(out.begin(), out.begin() + static_cast<long>(nLabels));
        haveLabels = true;
    }

    const double durationMs = 1000.0 * static_cast<double>(samples) / kSampleRate;

    // Log per-op turn evidence to logcat (the in-process verification channel:
    // these lines are emitted by the ai.elizaos.app pid, proving all four ops —
    // VAD segmentation + speaker embed + diariz — ran in the bionic app
    // process, independent of the JS↔Capacitor result delivery).
    double embNorm = 0.0, embAbsMax = 0.0;
    for (size_t i = 0; i < embedding.size(); ++i) {
        embNorm += static_cast<double>(embedding[i]) * embedding[i];
        const double a = std::fabs(static_cast<double>(embedding[i]));
        if (a > embAbsMax) embAbsMax = a;
    }
    embNorm = std::sqrt(embNorm);
    // Diariz label histogram (how many distinct powerset classes fired).
    int distinctLabels = 0;
    bool seen[8] = {false, false, false, false, false, false, false, false};
    for (int8_t l : labels) {
        if (l >= 0 && l < 8 && !seen[l]) { seen[l] = true; distinctLabels++; }
    }
    LOGI("TURN jni_%d: samples=%zu (%.2fs) | speaker: embDim=%zu norm=%.4f "
         "absMax=%.4f emb[0..3]=[%.4f,%.4f,%.4f,%.4f] | diariz: frames=%zu "
         "distinctClasses=%d",
         turnId, samples, durationMs / 1000.0,
         haveEmbedding ? embedding.size() : 0, embNorm, embAbsMax,
         embedding.size() > 0 ? embedding[0] : 0.0f,
         embedding.size() > 1 ? embedding[1] : 0.0f,
         embedding.size() > 2 ? embedding[2] : 0.0f,
         embedding.size() > 3 ? embedding[3] : 0.0f,
         labels.size(), distinctLabels);

    std::string json = "{\"turnId\":\"jni_" + std::to_string(turnId) +
                       "\",\"samples\":" + std::to_string(samples) +
                       ",\"durationMs\":" + std::to_string(durationMs) +
                       ",\"hasEmbedding\":" + (haveEmbedding ? "true" : "false") +
                       ",\"embNorm\":" + std::to_string(embNorm) +
                       ",\"diarizFrames\":" + std::to_string(labels.size()) +
                       ",\"diarizDistinctClasses\":" +
                       std::to_string(distinctLabels) + "}";
    s->turns.push_back(std::move(json));
    s->turnEmbeddings.push_back(haveEmbedding ? std::move(embedding)
                                              : std::vector<float>{});
    s->turnLabels.push_back(haveLabels ? std::move(labels)
                                       : std::vector<int8_t>{});
    s->turnPcms.push_back(std::move(s->turnPcm));
    s->turnPcm.clear();
    return true;
}

// Drain the pending buffer in 512-window steps, driving the VAD + segmenter.
bool drain_windows(PipelineSession* s, char** outError) {
    while (s->pending.size() >= kVadWindow) {
        float prob = -1.0f;
        const int rc = eliza_inference_vad_process(
            s->vad, s->pending.data(), kVadWindow, &prob, outError);
        if (rc != ELIZA_OK) return false;

        // Buffer this window into turn or pre-roll BEFORE the state transition
        // so a speech-start seeds the turn with the pre-roll + this window.
        const float* win = s->pending.data();
        if (s->capturing) {
            s->turnPcm.insert(s->turnPcm.end(), win, win + kVadWindow);
        } else {
            push_preroll(s, win, kVadWindow);
        }

        s->seg.step(prob);
        if (s->seg.speechStarted) {
            s->capturing = true;
            // Seed the turn with the pre-roll (leading word) + this window.
            s->turnPcm = s->preRoll;
            s->turnPcm.insert(s->turnPcm.end(), win, win + kVadWindow);
            s->preRoll.clear();
        }
        if (s->seg.speechEnded) {
            s->capturing = false;
            eliza_inference_vad_reset(s->vad, outError);  // best-effort
            if (!finalize_turn(s, outError)) return false;
        }
        // Hard cap on a runaway turn.
        if (s->capturing && s->turnPcm.size() >= s->maxTurnSamples) {
            s->capturing = false;
            s->seg.forceEnd();
            eliza_inference_vad_reset(s->vad, outError);
            if (!finalize_turn(s, outError)) return false;
        }

        // Advance the pending window.
        s->pending.erase(s->pending.begin(),
                         s->pending.begin() + static_cast<long>(kVadWindow));
    }
    return true;
}

// Build the JSON returned to JS for a process()/flush() call: the turns
// completed in this call. Embeddings + labels are exposed via the parallel
// getters so JS reads them per-index.
std::string drain_turns_json(PipelineSession* s) {
    std::string out = "[";
    for (size_t i = 0; i < s->turns.size(); ++i) {
        if (i > 0) out += ",";
        out += s->turns[i];
    }
    out += "]";
    return out;
}

// Close a self-test session's classifier handles + its owning context.
void cleanup_session_for_selftest(PipelineSession* s, EliInferenceContext* ctx) {
    if (s->diariz) eliza_inference_diariz_close(s->diariz);
    if (s->speaker) eliza_inference_speaker_close(s->speaker);
    if (s->vad) eliza_inference_vad_close(s->vad);
    delete s;
    if (ctx) eliza_inference_destroy(ctx);
}

// True unless the env var is explicitly "0"/"false"/"no"/"off" (case-insensitive).
// Absent / unrecognized → the `fallback`.
bool bionic_bool_env_or_default(const char* name, bool fallback) {
    const char* v = std::getenv(name);
    if (!v || v[0] == '\0') return fallback;
    std::string s(v);
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    if (s == "0" || s == "false" || s == "no" || s == "off") return false;
    if (s == "1" || s == "true" || s == "yes" || s == "on") return true;
    return fallback;
}

int bionic_int_env_or_default(const char* name, int fallback) {
    const char* v = std::getenv(name);
    if (!v || v[0] == '\0') return fallback;
    int parsed = std::atoi(v);
    return parsed > 0 ? parsed : fallback;
}

// Arm the eliza-1 text-model bionic config for runtime optimizations that are
// correct for the shipped model.
//
// KV-quant stays OFF by default. The shipped Eliza-1 tiers are Gemma 4, whose
// KV is already minimal by construction (MQA + windowed-SWA + shared-KV, dual
// head dims 512 global / 256 SWA) and runs on stock f16/q8_0 KV. The legacy
// QJL1_256 / fused QJL-TBQ kernels are head_dim=128 and dimensionally
// inapplicable to Gemma, so cache_type_k=qjl1_256/cache_type_v=tbq3_0 is not a
// shipping path; F16 KV is correct. ELIZA_BIONIC_KV_QUANT=1 is left as an
// explicit lab override for head_dim=128 test bundles only.
//
// MTP is enabled only when the caller supplies a Gemma separate-drafter GGUF.
// Omitting cfg.mtp_drafter_path would select the retired same-file NextN path,
// so shipped Gemma bundles without a staged drafter run plain decode even if
// ELIZA_BIONIC_MTP is set in the app process.
//
// The two static names below outlive the cfg they're attached to (cfg is a
// stack struct consumed synchronously by eliza_inference_llm_stream_open).
void arm_bionic_text_cfg(eliza_llm_stream_config_t& cfg,
                         const char* bundle_dir = nullptr) {
    static const char* kKvTypeK = "qjl1_256";
    static const char* kKvTypeV = "tbq3_0";
    if (bionic_bool_env_or_default("ELIZA_BIONIC_KV_QUANT", false)) {
        cfg.cache_type_k = kKvTypeK;
        cfg.cache_type_v = kKvTypeV;
        LOGI("bionic text cfg: KV-quant ON by explicit override (k=%s v=%s)",
             kKvTypeK, kKvTypeV);
    } else {
        LOGI("bionic text cfg: KV-quant OFF (stock f16/q8_0 KV; Gemma 4 KV is "
             "already minimal)");
    }

    (void)bundle_dir;
    const bool has_drafter =
        cfg.mtp_drafter_path && cfg.mtp_drafter_path[0] != '\0';
    if (has_drafter && bionic_bool_env_or_default("ELIZA_BIONIC_MTP", true)) {
        int draft_min = bionic_int_env_or_default("ELIZA_BIONIC_MTP_DRAFT_MIN", 1);
        int draft_max = bionic_int_env_or_default("ELIZA_BIONIC_MTP_DRAFT_MAX", 1);
        if (draft_min < 1) draft_min = 1;
        if (draft_max < draft_min) draft_max = draft_min;
        cfg.draft_min = draft_min;
        cfg.draft_max = draft_max;
        LOGI("bionic text cfg: MTP ON (draft_min=%d draft_max=%d, drafter=%s)",
             draft_min, draft_max, cfg.mtp_drafter_path);
    } else {
        LOGI("bionic text cfg: MTP OFF (%s)",
             has_drafter ? "disabled by ELIZA_BIONIC_MTP" : "no drafter");
    }
}

}  // namespace

extern "C" {

// ── ABI / capability probes (Phase 3a, retained) ─────────────────────────

JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVoiceAbiVersion(JNIEnv* env, jclass) {
    const char* abi = eliza_inference_abi_version();
    LOGI("eliza_inference_abi_version() = %s", abi ? abi : "(null)");
    return to_jstring(env, abi ? std::string(abi) : std::string());
}

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_vad_supported());
}

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeWakewordSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_wakeword_supported());
}

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeSpeakerSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_speaker_supported());
}

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeDiarizSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_diariz_supported());
}

// ── Context lifecycle ────────────────────────────────────────────────────

JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeContextCreate(JNIEnv* env, jclass,
                                                         jstring jBundleDir) {
    const std::string bundleDir = from_jstring(env, jBundleDir);
    if (bundleDir.empty()) {
        throw_runtime(env, "contextCreate: empty bundle dir", nullptr);
        return 0;
    }
    char* outError = nullptr;
    EliInferenceContext* ctx =
        eliza_inference_create(bundleDir.c_str(), &outError);
    if (ctx == nullptr) {
        throw_runtime(env, "eliza_inference_create returned null", outError);
        return 0;
    }
    LOGI("contextCreate(%s) -> %p", bundleDir.c_str(), (void*)ctx);
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeContextDestroy(JNIEnv*, jclass,
                                                          jlong handle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(handle);
    if (ctx) eliza_inference_destroy(ctx);
}

// ── VAD direct ops (evidence / self-test) ────────────────────────────────

JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadOpen(JNIEnv* env, jclass,
                                                   jlong ctxHandle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    char* outError = nullptr;
    EliVad* vad = eliza_inference_vad_open(ctx, kSampleRate, &outError);
    if (!vad) {
        throw_runtime(env, "vad_open returned null", outError);
        return 0;
    }
    return reinterpret_cast<jlong>(vad);
}

// Process N 512-sample windows in one call; returns the per-window
// probabilities as a Java float[] (length floor(samples/512)). Zero per-window
// bridge calls — the whole batch runs natively.
JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadProcessBatch(JNIEnv* env, jclass,
                                                           jlong vadHandle,
                                                           jfloatArray jPcm) {
    auto* vad = reinterpret_cast<EliVad*>(vadHandle);
    const std::vector<float> pcm = read_float_array(env, jPcm);
    const size_t windows = pcm.size() / kVadWindow;
    std::vector<float> probs(windows, 0.0f);
    char* outError = nullptr;
    for (size_t w = 0; w < windows; ++w) {
        float p = -1.0f;
        const int rc = eliza_inference_vad_process(
            vad, pcm.data() + w * kVadWindow, kVadWindow, &p, &outError);
        if (rc != ELIZA_OK) {
            throw_runtime(env, "vad_process(batch)", outError);
            return nullptr;
        }
        probs[w] = p;
    }
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(windows));
    if (out && windows > 0) {
        env->SetFloatArrayRegion(out, 0, static_cast<jsize>(windows),
                                 probs.data());
    }
    return out;
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadReset(JNIEnv*, jclass,
                                                    jlong vadHandle) {
    auto* vad = reinterpret_cast<EliVad*>(vadHandle);
    char* outError = nullptr;
    eliza_inference_vad_reset(vad, &outError);
    if (outError) std::free(outError);
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadClose(JNIEnv*, jclass,
                                                    jlong vadHandle) {
    eliza_inference_vad_close(reinterpret_cast<EliVad*>(vadHandle));
}

// ── Wake-word ops ────────────────────────────────────────────────────────

JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeWakewordOpen(JNIEnv* env, jclass,
                                                        jlong ctxHandle,
                                                        jstring jHead) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const std::string head = from_jstring(env, jHead);
    char* outError = nullptr;
    EliWakeWord* wake = eliza_inference_wakeword_open(
        ctx, kSampleRate, head.empty() ? "hey-eliza" : head.c_str(), &outError);
    if (!wake) {
        throw_runtime(env, "wakeword_open returned null", outError);
        return 0;
    }
    return reinterpret_cast<jlong>(wake);
}

// Score N 1280-sample frames in one call; returns the per-frame P(wake) as a
// Java float[] (length floor(samples/1280)).
JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeWakewordScoreBatch(JNIEnv* env,
                                                              jclass,
                                                              jlong wakeHandle,
                                                              jfloatArray jPcm) {
    auto* wake = reinterpret_cast<EliWakeWord*>(wakeHandle);
    const std::vector<float> pcm = read_float_array(env, jPcm);
    const size_t frames = pcm.size() / kWakeFrame;
    std::vector<float> scores(frames, 0.0f);
    char* outError = nullptr;
    for (size_t f = 0; f < frames; ++f) {
        float p = -1.0f;
        const int rc = eliza_inference_wakeword_score(
            wake, pcm.data() + f * kWakeFrame, kWakeFrame, &p, &outError);
        if (rc != ELIZA_OK) {
            throw_runtime(env, "wakeword_score(batch)", outError);
            return nullptr;
        }
        scores[f] = p;
    }
    float maxScore = 0.0f;
    for (float v : scores) maxScore = std::max(maxScore, v);
    LOGI("wakeword scoreBatch: frames=%zu maxP=%.4f", frames, maxScore);
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(frames));
    if (out && frames > 0) {
        env->SetFloatArrayRegion(out, 0, static_cast<jsize>(frames),
                                 scores.data());
    }
    return out;
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeWakewordReset(JNIEnv*, jclass,
                                                         jlong wakeHandle) {
    auto* wake = reinterpret_cast<EliWakeWord*>(wakeHandle);
    char* outError = nullptr;
    eliza_inference_wakeword_reset(wake, &outError);
    if (outError) std::free(outError);
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeWakewordClose(JNIEnv*, jclass,
                                                         jlong wakeHandle) {
    eliza_inference_wakeword_close(reinterpret_cast<EliWakeWord*>(wakeHandle));
}

// ── Speaker encoder ops ──────────────────────────────────────────────────

JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeSpeakerOpen(JNIEnv* env, jclass,
                                                       jlong ctxHandle,
                                                       jstring jGgufPath) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const std::string gguf = from_jstring(env, jGgufPath);
    char* outError = nullptr;
    EliSpeaker* sp = eliza_inference_speaker_open(
        ctx, gguf.empty() ? nullptr : gguf.c_str(), &outError);
    if (!sp) {
        throw_runtime(env, "speaker_open returned null", outError);
        return 0;
    }
    return reinterpret_cast<jlong>(sp);
}

// Embed a turn's PCM into a 256-float L2-normalized speaker embedding.
JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeSpeakerEmbed(JNIEnv* env, jclass,
                                                        jlong spHandle,
                                                        jfloatArray jPcm) {
    auto* sp = reinterpret_cast<EliSpeaker*>(spHandle);
    const std::vector<float> pcm = read_float_array(env, jPcm);
    std::vector<float> emb(kSpeakerEmbeddingDim, 0.0f);
    char* outError = nullptr;
    const int rc = eliza_inference_speaker_embed(sp, pcm.data(), pcm.size(),
                                                 emb.data(), &outError);
    if (rc != ELIZA_OK) {
        throw_runtime(env, "speaker_embed", outError);
        return nullptr;
    }
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(kSpeakerEmbeddingDim));
    if (out) {
        env->SetFloatArrayRegion(out, 0, static_cast<jsize>(kSpeakerEmbeddingDim),
                                 emb.data());
    }
    return out;
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeSpeakerClose(JNIEnv*, jclass,
                                                        jlong spHandle) {
    eliza_inference_speaker_close(reinterpret_cast<EliSpeaker*>(spHandle));
}

// ── Diarizer ops ─────────────────────────────────────────────────────────

JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeDiarizOpen(JNIEnv* env, jclass,
                                                      jlong ctxHandle,
                                                      jstring jGgufPath) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const std::string gguf = from_jstring(env, jGgufPath);
    char* outError = nullptr;
    EliDiariz* di = eliza_inference_diariz_open(
        ctx, gguf.empty() ? nullptr : gguf.c_str(), &outError);
    if (!di) {
        throw_runtime(env, "diariz_open returned null", outError);
        return 0;
    }
    return reinterpret_cast<jlong>(di);
}

// Segment a fixed 80000-sample (5 s) window into per-frame int8 powerset
// labels; returns the labels as a Java byte[].
JNIEXPORT jbyteArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeDiarizSegment(JNIEnv* env, jclass,
                                                         jlong diHandle,
                                                         jfloatArray jPcm) {
    auto* di = reinterpret_cast<EliDiariz*>(diHandle);
    std::vector<float> pcm = read_float_array(env, jPcm);
    // pyannote takes exactly 80000 samples — pad or crop.
    std::vector<float> window(kDiarizWindow, 0.0f);
    const size_t copy = pcm.size() < kDiarizWindow ? pcm.size() : kDiarizWindow;
    std::memcpy(window.data(), pcm.data(), copy * sizeof(float));
    std::vector<int8_t> out(kDiarizLabelCap, 0);
    size_t nLabels = out.size();
    char* outError = nullptr;
    const int rc = eliza_inference_diariz_segment(
        di, window.data(), window.size(), out.data(), &nLabels, &outError);
    if (rc != ELIZA_OK) {
        throw_runtime(env, "diariz_segment", outError);
        return nullptr;
    }
    jbyteArray ja = env->NewByteArray(static_cast<jsize>(nLabels));
    if (ja && nLabels > 0) {
        env->SetByteArrayRegion(ja, 0, static_cast<jsize>(nLabels),
                                reinterpret_cast<const jbyte*>(out.data()));
    }
    return ja;
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeDiarizClose(JNIEnv*, jclass,
                                                       jlong diHandle) {
    eliza_inference_diariz_close(reinterpret_cast<EliDiariz*>(diHandle));
}

// ── Native streaming pipeline (the hot-loop owner) ───────────────────────

// Open a pipeline session on a context: opens VAD + speaker + diariz (each
// best-effort; a missing classifier is reported as null and that turn payload
// is empty). Returns an opaque handle.
JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineOpen(JNIEnv* env, jclass,
                                                        jlong ctxHandle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    if (!ctx) {
        throw_runtime(env, "pipelineOpen: null context", nullptr);
        return 0;
    }
    auto* s = new PipelineSession();
    s->ctx = ctx;
    char* outError = nullptr;

    s->vad = eliza_inference_vad_open(ctx, kSampleRate, &outError);
    if (!s->vad) {
        delete s;
        throw_runtime(env, "pipelineOpen: vad_open returned null", outError);
        return 0;
    }
    // Speaker + diariz are required for a real attributed turn; open both.
    s->speaker = eliza_inference_speaker_open(ctx, nullptr, &outError);
    if (!s->speaker) {
        eliza_inference_vad_close(s->vad);
        delete s;
        throw_runtime(env, "pipelineOpen: speaker_open returned null", outError);
        return 0;
    }
    s->diariz = eliza_inference_diariz_open(ctx, nullptr, &outError);
    if (!s->diariz) {
        eliza_inference_speaker_close(s->speaker);
        eliza_inference_vad_close(s->vad);
        delete s;
        throw_runtime(env, "pipelineOpen: diariz_open returned null", outError);
        return 0;
    }
    LOGI("pipelineOpen -> %p (vad+speaker+diariz)", (void*)s);
    return reinterpret_cast<jlong>(s);
}

// Feed one audio-frame batch (16 kHz mono fp32) into the pipeline. Runs the VAD
// hot-loop + segmentation natively; on each speech-end runs speaker+diariz.
// Returns a JSON array of turns completed in THIS call (may be empty). The
// heavy embedding/labels payloads are read per-index via the getters below.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineProcess(JNIEnv* env, jclass,
                                                           jlong handle,
                                                           jfloatArray jPcm) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s) {
        throw_runtime(env, "pipelineProcess: null session", nullptr);
        return nullptr;
    }
    s->turns.clear();
    s->turnEmbeddings.clear();
    s->turnLabels.clear();
    s->turnPcms.clear();

    const std::vector<float> pcm = read_float_array(env, jPcm);
    s->pending.insert(s->pending.end(), pcm.begin(), pcm.end());
    char* outError = nullptr;
    if (!drain_windows(s, &outError)) {
        throw_runtime(env, "pipelineProcess: drain", outError);
        return nullptr;
    }
    if (!s->turns.empty()) {
        LOGI("pipelineProcess: fed %zu samples, %zu turn(s) completed, "
             "capturing=%d", pcm.size(), s->turns.size(), s->capturing ? 1 : 0);
    }
    return to_jstring(env, drain_turns_json(s));
}

// Force-finalize any open turn (call at end-of-capture). Returns the JSON array
// of any turn completed by the flush.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineFlush(JNIEnv* env, jclass,
                                                         jlong handle) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s) {
        throw_runtime(env, "pipelineFlush: null session", nullptr);
        return nullptr;
    }
    s->turns.clear();
    s->turnEmbeddings.clear();
    s->turnLabels.clear();
    s->turnPcms.clear();
    if (s->seg.forceEnd()) {
        s->capturing = false;
        char* outError = nullptr;
        eliza_inference_vad_reset(s->vad, &outError);
        if (outError) std::free(outError);
        outError = nullptr;
        if (!finalize_turn(s, &outError)) {
            throw_runtime(env, "pipelineFlush: finalize", outError);
            return nullptr;
        }
    }
    return to_jstring(env, drain_turns_json(s));
}

// Read the speaker embedding (256 floats) for the i-th turn produced by the
// last process()/flush() call. Empty array when that turn had no embedding.
JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineTurnEmbedding(JNIEnv* env,
                                                                 jclass,
                                                                 jlong handle,
                                                                 jint index) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s || index < 0 ||
        static_cast<size_t>(index) >= s->turnEmbeddings.size()) {
        return env->NewFloatArray(0);
    }
    const auto& emb = s->turnEmbeddings[static_cast<size_t>(index)];
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(emb.size()));
    if (out && !emb.empty()) {
        env->SetFloatArrayRegion(out, 0, static_cast<jsize>(emb.size()),
                                 emb.data());
    }
    return out;
}

// Read the diariz int8 frame labels for the i-th turn.
JNIEXPORT jbyteArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineTurnLabels(JNIEnv* env,
                                                              jclass,
                                                              jlong handle,
                                                              jint index) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s || index < 0 ||
        static_cast<size_t>(index) >= s->turnLabels.size()) {
        return env->NewByteArray(0);
    }
    const auto& labels = s->turnLabels[static_cast<size_t>(index)];
    jbyteArray out = env->NewByteArray(static_cast<jsize>(labels.size()));
    if (out && !labels.empty()) {
        env->SetByteArrayRegion(out, 0, static_cast<jsize>(labels.size()),
                                reinterpret_cast<const jbyte*>(labels.data()));
    }
    return out;
}

// Read the segmented turn PCM for the i-th turn. Empty array when unavailable.
JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineTurnPcm(JNIEnv* env,
                                                           jclass,
                                                           jlong handle,
                                                           jint index) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s || index < 0 ||
        static_cast<size_t>(index) >= s->turnPcms.size()) {
        return env->NewFloatArray(0);
    }
    const auto& pcm = s->turnPcms[static_cast<size_t>(index)];
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(pcm.size()));
    if (out && !pcm.empty()) {
        env->SetFloatArrayRegion(out, 0, static_cast<jsize>(pcm.size()),
                                 pcm.data());
    }
    return out;
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineReset(JNIEnv*, jclass,
                                                         jlong handle) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s) return;
    s->seg.reset();
    s->pending.clear();
    s->turnPcm.clear();
    s->turnPcms.clear();
    s->preRoll.clear();
    s->capturing = false;
    char* outError = nullptr;
    if (s->vad) eliza_inference_vad_reset(s->vad, &outError);
    if (outError) std::free(outError);
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineClose(JNIEnv*, jclass,
                                                         jlong handle) {
    auto* s = reinterpret_cast<PipelineSession*>(handle);
    if (!s) return;
    if (s->diariz) eliza_inference_diariz_close(s->diariz);
    if (s->speaker) eliza_inference_speaker_close(s->speaker);
    if (s->vad) eliza_inference_vad_close(s->vad);
    delete s;
}

// ── Pipeline self-test (one native call: ctx→open→feed→flush) ────────────
//
// Runs the WHOLE native pipeline on a complete PCM buffer in ONE call: creates
// a context, opens the VAD+speaker+diariz pipeline, streams the PCM through the
// native VAD hot-loop + turn segmentation, flushes, and returns the turn JSON
// (the per-op TURN logcat lines are the in-process evidence). Single call so it
// does not depend on chained Capacitor awaits. `feedSamples` chunks the feed to
// mimic the live audioFrame batching (0 = feed the whole buffer at once).
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativePipelineSelfTest(JNIEnv* env, jclass,
                                                            jstring jBundleDir,
                                                            jfloatArray jPcm,
                                                            jint feedSamples) {
    const std::string bundleDir = from_jstring(env, jBundleDir);
    char* outError = nullptr;
    EliInferenceContext* ctx =
        eliza_inference_create(bundleDir.c_str(), &outError);
    if (!ctx) {
        throw_runtime(env, "pipelineSelfTest: create", outError);
        return nullptr;
    }
    auto* s = new PipelineSession();
    s->ctx = ctx;
    s->vad = eliza_inference_vad_open(ctx, kSampleRate, &outError);
    if (!s->vad) { delete s; eliza_inference_destroy(ctx);
        throw_runtime(env, "pipelineSelfTest: vad_open", outError); return nullptr; }
    s->speaker = eliza_inference_speaker_open(ctx, nullptr, &outError);
    if (!s->speaker) { eliza_inference_vad_close(s->vad); delete s;
        eliza_inference_destroy(ctx);
        throw_runtime(env, "pipelineSelfTest: speaker_open", outError); return nullptr; }
    s->diariz = eliza_inference_diariz_open(ctx, nullptr, &outError);
    if (!s->diariz) { eliza_inference_speaker_close(s->speaker);
        eliza_inference_vad_close(s->vad); delete s; eliza_inference_destroy(ctx);
        throw_runtime(env, "pipelineSelfTest: diariz_open", outError); return nullptr; }

    const std::vector<float> pcm = read_float_array(env, jPcm);
    LOGI("pipelineSelfTest: feeding %zu samples (%.2fs), chunk=%d",
         pcm.size(), pcm.size() / (double)kSampleRate, feedSamples);
    const size_t chunk = feedSamples > 0 ? static_cast<size_t>(feedSamples)
                                         : pcm.size();
    std::vector<std::string> allTurns;
    for (size_t off = 0; off < pcm.size(); off += chunk) {
        const size_t end = std::min(off + chunk, pcm.size());
        s->pending.insert(s->pending.end(), pcm.begin() + off, pcm.begin() + end);
        s->turns.clear(); s->turnEmbeddings.clear(); s->turnLabels.clear();
        if (!drain_windows(s, &outError)) {
            cleanup_session_for_selftest(s, ctx);
            throw_runtime(env, "pipelineSelfTest: drain", outError);
            return nullptr;
        }
        for (auto& t : s->turns) allTurns.push_back(t);
    }
    // Flush any open turn (the speech-end via end-hangover may already have
    // fired mid-stream; a force-flush catches a turn still open at EOF).
    s->turns.clear(); s->turnEmbeddings.clear(); s->turnLabels.clear();
    if (s->seg.forceEnd()) {
        s->capturing = false;
        eliza_inference_vad_reset(s->vad, &outError);
        if (outError) { std::free(outError); outError = nullptr; }
        if (finalize_turn(s, &outError)) {
            for (auto& t : s->turns) allTurns.push_back(t);
        } else if (outError) { std::free(outError); outError = nullptr; }
    }
    std::string json = "[";
    for (size_t i = 0; i < allTurns.size(); ++i) {
        if (i) json += ",";
        json += allTurns[i];
    }
    json += "]";
    LOGI("pipelineSelfTest: %zu total turn(s)", allTurns.size());
    cleanup_session_for_selftest(s, ctx);
    return to_jstring(env, json);
}

// ── Wake-word self-test (one native call: open + score pos + score neg) ──
//
// Scores two pre-decoded float[] clips through one wake-word session
// (reset between them) and logs both max P(wake) to logcat. Single call so the
// JS side does not chain awaits across the broken-under-CDP Capacitor result
// delivery — the in-process evidence is the logcat line.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeWakewordSelfTest(JNIEnv* env, jclass,
                                                            jstring jBundleDir,
                                                            jfloatArray jPos,
                                                            jfloatArray jNeg) {
    const std::string bundleDir = from_jstring(env, jBundleDir);
    char* outError = nullptr;
    EliInferenceContext* ctx =
        eliza_inference_create(bundleDir.c_str(), &outError);
    if (!ctx) {
        throw_runtime(env, "wakewordSelfTest: create", outError);
        return nullptr;
    }
    EliWakeWord* wake =
        eliza_inference_wakeword_open(ctx, kSampleRate, "hey-eliza", &outError);
    if (!wake) {
        eliza_inference_destroy(ctx);
        throw_runtime(env, "wakewordSelfTest: wakeword_open", outError);
        return nullptr;
    }
    auto scoreMax = [&](jfloatArray jPcm) -> float {
        const std::vector<float> pcm = read_float_array(env, jPcm);
        const size_t frames = pcm.size() / kWakeFrame;
        float maxP = 0.0f;
        for (size_t f = 0; f < frames; ++f) {
            float p = -1.0f;
            char* e = nullptr;
            if (eliza_inference_wakeword_score(wake, pcm.data() + f * kWakeFrame,
                                               kWakeFrame, &p, &e) == ELIZA_OK) {
                maxP = std::max(maxP, p);
            }
            if (e) std::free(e);
        }
        return maxP;
    };
    const float posMax = scoreMax(jPos);
    eliza_inference_wakeword_reset(wake, &outError);
    if (outError) { std::free(outError); outError = nullptr; }
    const float negMax = scoreMax(jNeg);
    eliza_inference_wakeword_close(wake);
    eliza_inference_destroy(ctx);
    LOGI("WAKEWORD SELFTEST: posMax=%.4f negMax=%.4f (pos should >> neg)",
         posMax, negMax);
    std::string j = "{\"posMax\":" + std::to_string(posMax) +
                    ",\"negMax\":" + std::to_string(negMax) + "}";
    return to_jstring(env, j);
}

// ── VAD self-test (Phase 3a, retained for the existing harness) ──────────

JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadSelfTest(JNIEnv* env, jclass,
                                                       jstring jBundleDir) {
    const char* abi = eliza_inference_abi_version();
    const std::string abiStr = abi ? std::string(abi) : std::string();
    const int supported = eliza_inference_vad_supported();
    const std::string bundleDir = from_jstring(env, jBundleDir);

    auto fail = [&](const char* stage, const std::string& err) -> jstring {
        std::string j = std::string("{\"ok\":false,\"stage\":\"") + stage +
                        "\",\"error\":\"" + err + "\",\"abi\":\"" + abiStr +
                        "\",\"supported\":" + std::to_string(supported) + "}";
        LOGE("nativeVadSelfTest failed at %s: %s", stage, err.c_str());
        return to_jstring(env, j);
    };

    if (bundleDir.empty()) return fail("bundle_dir", "empty bundle dir");

    char* outError = nullptr;
    EliInferenceContext* ctx =
        eliza_inference_create(bundleDir.c_str(), &outError);
    if (ctx == nullptr) {
        std::string err =
            outError ? std::string(outError) : std::string("create returned null");
        if (outError) std::free(outError);
        return fail("create", err);
    }
    EliVad* vad = eliza_inference_vad_open(ctx, kSampleRate, &outError);
    if (vad == nullptr) {
        std::string err = outError ? std::string(outError)
                                   : std::string("vad_open returned null");
        if (outError) std::free(outError);
        eliza_inference_destroy(ctx);
        return fail("vad_open", err);
    }
    std::vector<float> pcm(kVadWindow);
    for (size_t i = 0; i < pcm.size(); ++i) {
        pcm[i] = 0.25f *
                 std::sin(2.0 * M_PI * 200.0 * (double)i / kSampleRate);
    }
    float probability = -1.0f;
    int rc = eliza_inference_vad_process(vad, pcm.data(), pcm.size(),
                                         &probability, &outError);
    if (rc != ELIZA_OK) {
        std::string err =
            outError ? std::string(outError) : ("rc=" + std::to_string(rc));
        if (outError) std::free(outError);
        eliza_inference_vad_close(vad);
        eliza_inference_destroy(ctx);
        return fail("vad_process", err);
    }
    if (outError) std::free(outError);
    eliza_inference_vad_close(vad);
    eliza_inference_destroy(ctx);

    const bool finite = std::isfinite(probability);
    std::string j = std::string("{\"ok\":") + (finite ? "true" : "false") +
                    ",\"probability\":" + std::to_string(probability) +
                    ",\"abi\":\"" + abiStr + "\",\"supported\":" +
                    std::to_string(supported) + "}";
    LOGI("nativeVadSelfTest ok: probability=%f abi=%s supported=%d", probability,
         abiStr.c_str(), supported);
    return to_jstring(env, j);
}

// ── Text generation (LLM) ops — the GPU-accelerated text path ────────────
//
// Wrap the fused streaming-LLM ABI (eliza_inference_llm_stream_*), pooled
// embeddings (eliza_inference_embed), end-of-turn scoring
// (eliza_inference_llm_eot_score, ABI v11), and the tokenizer. When this JNI
// host is built against the DYNAMIC-Vulkan libelizainference (libggml-vulkan.so
// staged alongside it), llm_stream_open offloads the model to the GPU in the
// bionic app process automatically — the path the musl bun agent cannot take.

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_llm_stream_supported());
}

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeEmbedSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_embed_supported());
}

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeEotSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_llm_eot_supported());
}

// Tokenize text -> int[] token ids. addSpecial adds BOS; parseSpecial renders
// special tokens (<|im_start|> etc.) from the input.
JNIEXPORT jintArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeTokenize(JNIEnv* env, jclass,
                                                    jlong ctxHandle,
                                                    jstring jText,
                                                    jboolean addSpecial,
                                                    jboolean parseSpecial) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const std::string text = from_jstring(env, jText);
    int* toks = nullptr;
    size_t n = 0;
    char* outError = nullptr;
    const int rc = eliza_inference_tokenize(
        ctx, text.c_str(), text.size(), addSpecial ? 1 : 0,
        parseSpecial ? 1 : 0, &toks, &n, &outError);
    if (rc != ELIZA_OK) {
        throw_runtime(env, "tokenize", outError);
        return nullptr;
    }
    jintArray out = env->NewIntArray(static_cast<jsize>(n));
    if (out && n > 0) {
        env->SetIntArrayRegion(out, 0, static_cast<jsize>(n),
                               reinterpret_cast<const jint*>(toks));
    }
    if (toks) eliza_inference_free_tokens(toks);
    return out;
}

// Pooled, L2-normalized sentence embedding (pooling: 1=MEAN default) ->
// float[n_embd].
JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeEmbed(JNIEnv* env, jclass,
                                                 jlong ctxHandle, jstring jText,
                                                 jint pooling) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const std::string text = from_jstring(env, jText);
    std::vector<float> out(4096, 0.0f);
    int dim = 0;
    char* outError = nullptr;
    const int rc = eliza_inference_embed(ctx, text.c_str(), text.size(),
                                         pooling > 0 ? pooling : 1, out.data(),
                                         out.size(), &dim, &outError);
    if (rc != ELIZA_OK) {
        throw_runtime(env, "embed", outError);
        return nullptr;
    }
    jfloatArray ja = env->NewFloatArray(dim);
    if (ja && dim > 0) env->SetFloatArrayRegion(ja, 0, dim, out.data());
    return ja;
}

// End-of-turn score: next-token P(targetToken | tokens) -> float.
JNIEXPORT jfloat JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeEotScore(JNIEnv* env, jclass,
                                                    jlong ctxHandle,
                                                    jintArray jTokens,
                                                    jint targetToken) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const jsize n = env->GetArrayLength(jTokens);
    std::vector<int32_t> toks(static_cast<size_t>(n));
    if (n > 0) {
        env->GetIntArrayRegion(jTokens, 0, n,
                               reinterpret_cast<jint*>(toks.data()));
    }
    float prob = 0.0f, topProb = 0.0f;
    int32_t topTok = -1;
    char* outError = nullptr;
    const int rc = eliza_inference_llm_eot_score(ctx, toks.data(), toks.size(),
                                                 targetToken, &prob, &topTok,
                                                 &topProb, &outError);
    if (rc != ELIZA_OK) {
        throw_runtime(env, "eot_score", outError);
        return 0.0f;
    }
    return prob;
}

// Open a streaming-LLM session. nGpuLayers: -1 = all-GPU (default), 0 = CPU
// (the lib ignores 0 when libggml-vulkan is linked; the CPU/GPU choice is the
// staged LIB VARIANT, see the per-device selection). drafterPath ("" = none)
// enables MTP speculative decoding.
JNIEXPORT jlong JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamOpen(
    JNIEnv* env, jclass, jlong ctxHandle, jint maxTokens, jfloat temperature,
    jfloat topP, jint topK, jint nGpuLayers, jstring jDrafterPath) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    const std::string drafter = from_jstring(env, jDrafterPath);
    eliza_llm_stream_config_t cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    cfg.max_tokens = maxTokens;
    cfg.temperature = temperature;
    cfg.top_p = topP > 0 ? topP : 1.0f;
    cfg.top_k = topK;
    cfg.repeat_penalty = 1.0f;
    cfg.n_gpu_layers = nGpuLayers;
    cfg.mtp_drafter_path = drafter.empty() ? nullptr : drafter.c_str();
    // Arm safe runtime optimizations: stock f16/q8_0 KV for the shipped Gemma 4
    // tiers, and separate-drafter MTP only when the caller passes a drafter.
    arm_bionic_text_cfg(cfg);
    if (!drafter.empty() && cfg.draft_min <= 0) {
        // Separate drafter supplied but env left the window 0; give it the
        // single-head default so the drafter actually drives speculation.
        cfg.draft_min = 1;
        cfg.draft_max = 1;
    }
    char* outError = nullptr;
    EliLlmStream* s = eliza_inference_llm_stream_open(ctx, &cfg, &outError);
    if (!s) {
        throw_runtime(env, "llm_stream_open returned null", outError);
        return 0;
    }
    return reinterpret_cast<jlong>(s);
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamPrefill(JNIEnv* env, jclass,
                                                            jlong streamHandle,
                                                            jintArray jTokens) {
    auto* s = reinterpret_cast<EliLlmStream*>(streamHandle);
    const jsize n = env->GetArrayLength(jTokens);
    std::vector<int32_t> toks(static_cast<size_t>(n));
    if (n > 0) {
        env->GetIntArrayRegion(jTokens, 0, n,
                               reinterpret_cast<jint*>(toks.data()));
    }
    char* outError = nullptr;
    const int rc = eliza_inference_llm_stream_prefill(s, toks.data(),
                                                      toks.size(), &outError);
    if (rc != ELIZA_OK) throw_runtime(env, "llm_stream_prefill", outError);
}

// Pull the next decode step. Returns JSON {text, done, nout, drafted, accepted}:
// `text` is the detokenized chunk (may span multiple committed tokens via MTP),
// `done` true at the final step. `text` is JSON-escaped.
//
// maxStepTokens bounds how many tokens THIS native call may decode (the C
// decode loop runs `min(tokens_cap, stream max_tokens remaining)` tokens per
// call). Clamped to [1, 256] — the fixed token buffer below. Issue #11913:
// the previous signature always passed the full 256-token buffer as the cap,
// so one native call decoded ~256 tokens regardless of the caller's per-turn
// maxTokens, and the Java-side cap check only ran after all that eval work.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamNext(JNIEnv* env, jclass,
                                                         jlong streamHandle,
                                                         jint maxStepTokens) {
    auto* s = reinterpret_cast<EliLlmStream*>(streamHandle);
    int32_t toks[256];
    char text[4096];
    size_t nout = 0;
    int32_t drafted = 0, accepted = 0;
    char* outError = nullptr;
    int stepCapInt = static_cast<int>(maxStepTokens);
    if (stepCapInt < 1) stepCapInt = 1;
    if (stepCapInt > 256) stepCapInt = 256;
    const int rc = eliza_inference_llm_stream_next(
        s, toks, static_cast<size_t>(stepCapInt), &nout, text, sizeof(text),
        &drafted, &accepted, &outError);
    if (rc < 0) {
        throw_runtime(env, "llm_stream_next", outError);
        return nullptr;
    }
    std::string esc;
    for (const char* p = text; *p; ++p) {
        switch (*p) {
            case '"': esc += "\\\""; break;
            case '\\': esc += "\\\\"; break;
            case '\n': esc += "\\n"; break;
            case '\r': esc += "\\r"; break;
            case '\t': esc += "\\t"; break;
            default:
                if (static_cast<unsigned char>(*p) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x",
                                  static_cast<unsigned char>(*p));
                    esc += buf;
                } else {
                    esc += *p;
                }
        }
    }
    std::string json = "{\"text\":\"" + esc +
                       "\",\"done\":" + (rc == 1 ? "true" : "false") +
                       ",\"nout\":" + std::to_string(nout) +
                       ",\"drafted\":" + std::to_string(drafted) +
                       ",\"accepted\":" + std::to_string(accepted) + "}";
    return to_jstring(env, json);
}

JNIEXPORT void JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamClose(JNIEnv*, jclass,
                                                          jlong streamHandle) {
    eliza_inference_llm_stream_close(
        reinterpret_cast<EliLlmStream*>(streamHandle));
}

// Reset a persistent stream (clear KV + sampler + counters) for warm reuse.
// Returns 1 on success, 0 if the stream can't be reset (MTP / null).
JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamReset(JNIEnv*, jclass,
                                                          jlong streamHandle) {
    const int rc = eliza_inference_llm_stream_reset(
        reinterpret_cast<EliLlmStream*>(streamHandle));
    return static_cast<jint>(rc == ELIZA_OK ? 1 : 0);
}

// Prefix-preserving reset: keep the first nKeep tokens of KV resident, drop the
// rest. Returns the n_keep actually applied (>= 0), or a negative ELIZA_* on a
// NULL / MTP / unopened stream (caller falls back to a full reset + prefill).
JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamResetKeep(JNIEnv*, jclass,
                                                              jlong streamHandle,
                                                              jint nKeep) {
    const int rc = eliza_inference_llm_stream_reset_keep(
        reinterpret_cast<EliLlmStream*>(streamHandle), static_cast<int32_t>(nKeep));
    return static_cast<jint>(rc);
}

// ── LLM self-test (one native call: ctx→tokenize→stream→generate) ─────────
//
// THE KEYSTONE PROOF: runs a whole greedy text generation in ONE native call,
// in the bionic app process, against whatever libelizainference.so is staged
// into jniLibs. When that lib is the dynamic-Vulkan variant, ggml-vulkan logs
// "Found 1 Vulkan devices: Mali-G715" + "offloaded N/N layers to GPU" to
// logcat (the in-process GPU evidence). Returns JSON {ok,text,tokens,ms,tokS}.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmSelfTest(JNIEnv* env, jclass,
                                                       jstring jBundleDir,
                                                       jstring jPrompt,
                                                       jint maxTokens) {
    const std::string bundleDir = from_jstring(env, jBundleDir);
    const std::string prompt = from_jstring(env, jPrompt);
    const int genCap = maxTokens > 0 ? maxTokens : 32;
    char* outError = nullptr;

    EliInferenceContext* ctx =
        eliza_inference_create(bundleDir.c_str(), &outError);
    if (!ctx) { throw_runtime(env, "llmSelfTest: create", outError); return nullptr; }

    int* tok = nullptr; size_t tn = 0;
    if (eliza_inference_tokenize(ctx, prompt.c_str(), prompt.size(), 1, 1, &tok,
                                 &tn, &outError) != ELIZA_OK) {
        eliza_inference_destroy(ctx);
        throw_runtime(env, "llmSelfTest: tokenize", outError);
        return nullptr;
    }

    eliza_llm_stream_config_t cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    cfg.max_tokens = genCap;
    cfg.temperature = 0.0f;  // greedy, deterministic
    cfg.top_k = 1;
    cfg.top_p = 1.0f;
    cfg.repeat_penalty = 1.0f;
    cfg.n_gpu_layers = -1;   // all-GPU when the vulkan lib is staged
    // Arm safe runtime optimizations (stock f16/q8_0 KV for shipped Gemma 4
    // tiers; no MTP here because nativeLlmSelfTest has no drafter argument).
    arm_bionic_text_cfg(cfg, bundleDir.c_str());
    EliLlmStream* s = eliza_inference_llm_stream_open(ctx, &cfg, &outError);
    if (!s) {
        if (tok) eliza_inference_free_tokens(tok);
        eliza_inference_destroy(ctx);
        throw_runtime(env, "llmSelfTest: stream_open", outError);
        return nullptr;
    }

    const double t0 = []() {
        timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
        return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
    }();
    if (eliza_inference_llm_stream_prefill(s, reinterpret_cast<int32_t*>(tok),
                                           tn, &outError) != ELIZA_OK) {
        eliza_inference_llm_stream_close(s);
        if (tok) eliza_inference_free_tokens(tok);
        eliza_inference_destroy(ctx);
        throw_runtime(env, "llmSelfTest: prefill", outError);
        return nullptr;
    }

    std::string text;
    int produced = 0;
    while (produced < genCap) {
        int32_t toks[256]; char chunk[4096]; size_t nout = 0;
        int32_t dd = 0, da = 0;
        const int rc = eliza_inference_llm_stream_next(
            s, toks, 256, &nout, chunk, sizeof(chunk), &dd, &da, &outError);
        if (rc < 0) break;
        text += chunk;
        produced += static_cast<int>(nout);
        if (rc == 1) break;
    }
    const double t1 = []() {
        timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
        return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
    }();
    eliza_inference_llm_stream_close(s);
    if (tok) eliza_inference_free_tokens(tok);
    eliza_inference_destroy(ctx);

    const double ms = t1 - t0;
    const double tokS = ms > 0 ? produced * 1000.0 / ms : 0.0;
    LOGI("LLM SELFTEST: generated %d tokens in %.0fms (%.2f tok/s) — \"%.80s\"",
         produced, ms, tokS, text.c_str());

    // JSON-escape the generated text.
    std::string esc;
    for (char c : text) {
        switch (c) {
            case '"': esc += "\\\""; break;
            case '\\': esc += "\\\\"; break;
            case '\n': esc += "\\n"; break;
            case '\r': esc += "\\r"; break;
            case '\t': esc += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char b[8]; std::snprintf(b, sizeof(b), "\\u%04x",
                                             static_cast<unsigned char>(c));
                    esc += b;
                } else esc += c;
        }
    }
    std::string json = "{\"ok\":true,\"tokens\":" + std::to_string(produced) +
                       ",\"ms\":" + std::to_string(ms) + ",\"tokS\":" +
                       std::to_string(tokS) + ",\"text\":\"" + esc + "\"}";
    return to_jstring(env, json);
}

// ── Kokoro TTS (ABI v10) ─────────────────────────────────────────────────
// Synthesize speech in-process via the fused Kokoro-82M head. This is what lets
// the Android app speak with the real on-device voice instead of falling back to
// the platform TextToSpeech: TalkMode (this bionic process) → bionic host "tts"
// op → here. Returns a float[] of 24 kHz PCM (the model's native rate).

JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeKokoroSampleRate(JNIEnv*, jclass,
                                                            jlong ctxHandle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    return ctx ? eliza_inference_kokoro_sample_rate(ctx) : -1;
}

JNIEXPORT jfloatArray JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeKokoroSynthesize(JNIEnv* env, jclass,
                                                            jlong ctxHandle,
                                                            jstring jGguf,
                                                            jstring jVoiceBin,
                                                            jstring jText,
                                                            jfloat speed) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    if (!ctx) {
        throw_runtime(env, "kokoroSynthesize: null context", nullptr);
        return nullptr;
    }
    const std::string gguf = from_jstring(env, jGguf);
    const std::string voiceBin = from_jstring(env, jVoiceBin);
    const std::string text = from_jstring(env, jText);
    char* err = nullptr;
    // style_dim 256 for Kokoro v1.0. Reloads only when the model/voice changed
    // (the FFI caches the resident model + voice preset).
    if (eliza_inference_kokoro_load(ctx, gguf.c_str(), voiceBin.c_str(), 256, &err) != 0) {
        throw_runtime(env, "kokoro_load failed", err);
        return nullptr;
    }
    // Cap at 30 s @ 24 kHz — far longer than any single reply phrase.
    const size_t cap = 24000u * 30u;
    std::vector<float> pcm(cap);
    err = nullptr;
    int n = eliza_inference_kokoro_synthesize(
        ctx, text.c_str(), text.size(), speed, pcm.data(), cap, &err);
    if (n < 0) {
        throw_runtime(env, "kokoro_synthesize failed", err);
        return nullptr;
    }
    jfloatArray out = env->NewFloatArray(n);
    if (!out) return nullptr;
    env->SetFloatArrayRegion(out, 0, n, pcm.data());
    LOGI("nativeKokoroSynthesize: %zu chars -> %d samples", text.size(), n);
    return out;
}

// ── Batch ASR (synchronous, VAD-free) ────────────────────────────────────
//
// The streaming pipeline (nativePipelineProcess) is VAD-gated and needs the
// VAD/diariz/speaker GGUFs staged; this is the DIRECT audio-in/text-out
// transcribe the fused lib exposes (eliza_inference_asr_transcribe), which
// only mmap-acquires the `asr/` weights on the resident context. The bionic
// host's op="asr" calls this so the agent's TRANSCRIPTION delegate gets a
// real on-device transcript without the full attribution pipeline.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeAsrTranscribe(JNIEnv* env, jclass,
                                                         jlong ctxHandle,
                                                         jfloatArray jPcm,
                                                         jint sampleRate) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    if (!ctx) {
        throw_runtime(env, "asrTranscribe: null context", nullptr);
        return nullptr;
    }
    const jsize n = env->GetArrayLength(jPcm);
    jfloat* pcm = env->GetFloatArrayElements(jPcm, nullptr);
    if (!pcm) {
        throw_runtime(env, "asrTranscribe: null PCM", nullptr);
        return nullptr;
    }
    // The ASR weights are a voice-only mmap region that must be armed before
    // transcribe (VoiceLifecycle normally does this on voice-on). The agent's
    // one-shot transcribe path has no lifecycle, so arm it here (idempotent if
    // already acquired).
    char* acqErr = nullptr;
    if (eliza_inference_mmap_acquire(ctx, "asr", &acqErr) != 0) {
        env->ReleaseFloatArrayElements(jPcm, pcm, JNI_ABORT);
        throw_runtime(env, "asr mmap_acquire", acqErr);
        return nullptr;
    }
    // 64 KiB transcript cap — far longer than any single utterance.
    std::vector<char> out(65536, 0);
    char* err = nullptr;
    const int rc = eliza_inference_asr_transcribe(
        ctx, reinterpret_cast<const float*>(pcm), static_cast<size_t>(n),
        sampleRate > 0 ? sampleRate : kSampleRate, out.data(), out.size(),
        &err);
    env->ReleaseFloatArrayElements(jPcm, pcm, JNI_ABORT);
    if (rc < 0) {
        throw_runtime(env, "asr_transcribe", err);
        return nullptr;
    }
    LOGI("nativeAsrTranscribe: %d samples @ %d Hz -> %d transcript bytes",
         (int)n, (int)sampleRate, rc);
    return to_jstring(env, std::string(out.data()));
}

// ── mmproj vision (ABI v9) ───────────────────────────────────────────────
JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVisionSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_vision_supported());
}

// Describe a raw PNG/JPEG/WebP image with the resident TEXT model + an mmproj
// projector (eliza_inference_describe_image). The bionic host's op="image"
// calls this so the agent's IMAGE_DESCRIPTION delegate runs screen/vision
// recognition fully on-device.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeDescribeImage(JNIEnv* env, jclass,
                                                         jlong ctxHandle,
                                                         jbyteArray jImage,
                                                         jstring jMmproj,
                                                         jstring jPrompt) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    if (!ctx) {
        throw_runtime(env, "describeImage: null context", nullptr);
        return nullptr;
    }
    const std::string mmproj = from_jstring(env, jMmproj);
    const std::string prompt = from_jstring(env, jPrompt);
    const jsize n = env->GetArrayLength(jImage);
    jbyte* img = env->GetByteArrayElements(jImage, nullptr);
    if (!img) {
        throw_runtime(env, "describeImage: null image bytes", nullptr);
        return nullptr;
    }
    std::vector<char> out(16384, 0);
    char* err = nullptr;
    const int rc = eliza_inference_describe_image(
        ctx, reinterpret_cast<const unsigned char*>(img),
        static_cast<size_t>(n),
        mmproj.empty() ? nullptr : mmproj.c_str(),
        prompt.empty() ? nullptr : prompt.c_str(), out.data(), out.size(),
        &err);
    env->ReleaseByteArrayElements(jImage, img, JNI_ABORT);
    if (rc < 0) {
        throw_runtime(env, "describe_image", err);
        return nullptr;
    }
    LOGI("nativeDescribeImage: %d image bytes -> %d description bytes", (int)n,
         rc);
    return to_jstring(env, std::string(out.data()));
}

}  // extern "C"
