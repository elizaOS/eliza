/**
 * Bridges fused inference into the Android bionic host through JNI.
 *
 * The natives are bound with RegisterNatives from JNI_OnLoad, so the library
 * exports JNI_OnLoad and nothing else. Consumers choose the Java class at
 * build time and do not rewrite this file:
 *   ELIZA_VOICE_JNI_CLASS   JNI class name, default ai/elizaos/app/ElizaVoiceNative
 *   ELIZA_VOICE_JNI_FULL    1 registers every native (the app host); 0 registers
 *                           only the voice subset (context, Paradee TTS, ASR
 *                           batch + streaming, cancel, memory regions) for
 *                           library consumers.
 * Text crosses the boundary as standard UTF-8 byte arrays, never JNI modified
 * UTF-8. Voice failures log the stage and status code only, never text.
 */

#include <jni.h>
#include <android/log.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <memory>
#include <new>
#include <string>
#include <vector>

#include "eliza-inference-ffi.h"

#if ELIZA_INFERENCE_ABI_VERSION < 19
#error "elizavoice-jni needs eliza-inference-ffi.h ABI 19 or newer (Paradee streaming)"
#endif

#ifndef ELIZA_VOICE_JNI_CLASS
#define ELIZA_VOICE_JNI_CLASS "ai/elizaos/app/ElizaVoiceNative"
#endif
#ifndef ELIZA_VOICE_JNI_FULL
#define ELIZA_VOICE_JNI_FULL 1
#endif

#define LOG_TAG "ElizaVoiceJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// ASR input rate when the caller passes none (must mirror the JS contract).
constexpr int kSampleRate = 16000;

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

// Read a Java byte[] holding standard UTF-8. Returns false with a pending
// exception when the array is missing.
bool read_utf8(JNIEnv* env, jbyteArray input, const char* stage, std::string& out) {
    if (input == nullptr) {
        throw_runtime(env, std::string(stage) + ": missing UTF-8 input", nullptr);
        return false;
    }
    const jsize length = env->GetArrayLength(input);
    out.resize(static_cast<size_t>(length));
    if (length > 0) {
        env->GetByteArrayRegion(input, 0, length, reinterpret_cast<jbyte*>(out.data()));
    }
    return !env->ExceptionCheck();
}

// Build a java.lang.String from standard UTF-8. NewStringUTF expects modified
// UTF-8 and aborts under CheckJNI on 4-byte sequences (emoji in a transcript),
// so decode to UTF-16 here. Invalid sequences become U+FFFD.
jstring utf8_to_jstring(JNIEnv* env, const char* data, size_t size) {
    std::u16string out;
    out.reserve(size);
    const auto* p = reinterpret_cast<const unsigned char*>(data);
    size_t i = 0;
    while (i < size) {
        const unsigned char c = p[i];
        uint32_t cp = 0xFFFD;
        size_t len = 1;
        if (c < 0x80) {
            cp = c;
        } else if ((c >> 5) == 0x6 && i + 1 < size && (p[i + 1] & 0xC0) == 0x80) {
            cp = ((c & 0x1Fu) << 6) | (p[i + 1] & 0x3Fu);
            len = 2;
            if (cp < 0x80) cp = 0xFFFD;
        } else if ((c >> 4) == 0xE && i + 2 < size && (p[i + 1] & 0xC0) == 0x80 &&
                   (p[i + 2] & 0xC0) == 0x80) {
            cp = ((c & 0x0Fu) << 12) | ((p[i + 1] & 0x3Fu) << 6) | (p[i + 2] & 0x3Fu);
            len = 3;
            if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        } else if ((c >> 3) == 0x1E && i + 3 < size && (p[i + 1] & 0xC0) == 0x80 &&
                   (p[i + 2] & 0xC0) == 0x80 && (p[i + 3] & 0xC0) == 0x80) {
            cp = ((c & 0x07u) << 18) | ((p[i + 1] & 0x3Fu) << 12) |
                 ((p[i + 2] & 0x3Fu) << 6) | (p[i + 3] & 0x3Fu);
            len = 4;
            if (cp < 0x10000 || cp > 0x10FFFF) cp = 0xFFFD;
        }
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
        } else {
            out.push_back(static_cast<char16_t>(cp));
        }
        i += len;
    }
    return env->NewString(reinterpret_cast<const jchar*>(out.data()),
                          static_cast<jsize>(out.size()));
}

// Throw for a failed voice call. ELIZA_ERR_CANCELLED becomes a typed
// java.util.concurrent.CancellationException so callers can tell a requested
// stop from a failure, and ELIZA_ERR_INVALID_ARG becomes
// IllegalArgumentException (a rejected input that leaves the context usable,
// so a host need not drop its resident state). Everything else is a
// RuntimeException. The log carries the stage and status code only: native
// diagnostics can quote the input text, so they go to the exception message.
void throw_voice(JNIEnv* env, const char* stage, int rc, char* outError) {
    std::string msg = std::string("[elizavoice-jni] ") + stage + " rc=" + std::to_string(rc);
    if (outError) {
        msg += ": ";
        msg += outError;
        std::free(outError);
    }
    LOGE("%s failed rc=%d", stage, rc);
    jclass cls = env->FindClass(rc == ELIZA_ERR_CANCELLED
                                    ? "java/util/concurrent/CancellationException"
                                    : rc == ELIZA_ERR_INVALID_ARG
                                        ? "java/lang/IllegalArgumentException"
                                        : "java/lang/RuntimeException");
    if (cls) env->ThrowNew(cls, msg.c_str());
}

EliInferenceContext* voice_context(JNIEnv* env, jlong handle, const char* stage) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(handle);
    if (!ctx) throw_voice(env, stage, ELIZA_ERR_INVALID_ARG, nullptr);
    return ctx;
}

// Hand a library-owned PCM buffer to Java and release it. A successful call
// with no speakable input (punctuation or symbols only) yields zero samples
// and a null buffer; that is an empty array, not a failure.
jfloatArray take_pcm(JNIEnv* env, const char* stage, float* pcm, size_t samples) {
    if (samples == 0) {
        eliza_inference_free_pcm(pcm);
        return env->NewFloatArray(0);
    }
    if (!pcm || samples > static_cast<size_t>(INT32_MAX)) {
        eliza_inference_free_pcm(pcm);
        throw_voice(env, stage, ELIZA_ERR_FFI_FAULT, nullptr);
        return nullptr;
    }
    const jsize n = static_cast<jsize>(samples);
    jfloatArray out = env->NewFloatArray(n);
    if (out) env->SetFloatArrayRegion(out, 0, n, pcm);
    eliza_inference_free_pcm(pcm);
    return out;
}

#if ELIZA_VOICE_JNI_FULL

// Window constants (must mirror the JS contract).
constexpr size_t kVadWindow = 512;       // Silero v5 window @ 16 kHz
constexpr size_t kWakeFrame = 1280;      // openWakeWord 80 ms frame @ 16 kHz
constexpr size_t kSpeakerEmbeddingDim = 256;
constexpr size_t kDiarizWindow = 80000;  // pyannote 5 s window @ 16 kHz
constexpr size_t kDiarizLabelCap = 2048;

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

    // Preserve coverage of the entire turn. Labels are local to each fixed
    // model window; expose offsets and valid sample counts rather than making
    // padding or independently inferred speaker classes look continuous.
    std::vector<int8_t> labels;
    std::string diarizWindows = "[";
    bool haveLabels = false;
    if (s->diariz) {
        for (size_t start = 0; start < samples; start += kDiarizWindow) {
            std::vector<float> window(kDiarizWindow, 0.0f);
            const size_t validSamples = std::min(samples - start, kDiarizWindow);
            std::memcpy(window.data(), s->turnPcm.data() + start,
                        validSamples * sizeof(float));
            std::vector<int8_t> out(kDiarizLabelCap, 0);
            size_t nLabels = out.size();
            const int rc = eliza_inference_diariz_segment(
                s->diariz, window.data(), window.size(), out.data(), &nLabels,
                outError);
            if (rc != ELIZA_OK) return false;
            if (haveLabels) diarizWindows += ",";
            diarizWindows += "{\"startSample\":" + std::to_string(start) +
                ",\"samples\":" + std::to_string(validSamples) +
                ",\"modelSamples\":" + std::to_string(kDiarizWindow) +
                ",\"labelOffset\":" + std::to_string(labels.size()) +
                ",\"labelCount\":" + std::to_string(nLabels) + "}";
            labels.insert(labels.end(), out.begin(), out.begin() + static_cast<long>(nLabels));
            haveLabels = true;
        }
    }
    diarizWindows += "]";

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
                       std::to_string(distinctLabels) + ",\"diarizWindows\":" + diarizWindows + "}";
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

        // Existing turns own this window. At onset, pre-roll must contain only
        // earlier audio so the triggering window is appended exactly once.
        const float* win = s->pending.data();
        if (s->capturing) {
            s->turnPcm.insert(s->turnPcm.end(), win, win + kVadWindow);
        }

        s->seg.step(prob);
        if (s->seg.speechStarted) {
            s->capturing = true;
            // Seed the turn with the pre-roll (leading word) + this window.
            s->turnPcm = s->preRoll;
            s->turnPcm.insert(s->turnPcm.end(), win, win + kVadWindow);
            s->preRoll.clear();
        } else if (!s->capturing) {
            push_preroll(s, win, kVadWindow);
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

#endif  // ELIZA_VOICE_JNI_FULL

// ── ABI / capability probes (Phase 3a, retained) ─────────────────────────

jstring nativeVoiceAbiVersion(JNIEnv* env, jclass) {
    const char* abi = eliza_inference_abi_version();
    LOGI("eliza_inference_abi_version() = %s", abi ? abi : "(null)");
    return to_jstring(env, abi ? std::string(abi) : std::string());
}

#if ELIZA_VOICE_JNI_FULL
jint nativeVadSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_vad_supported());
}

jint nativeWakewordSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_wakeword_supported());
}

jint nativeSpeakerSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_speaker_supported());
}

jint nativeDiarizSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_diariz_supported());
}

#endif  // ELIZA_VOICE_JNI_FULL

// ── Context lifecycle ────────────────────────────────────────────────────

jlong nativeContextCreate(JNIEnv* env, jclass,
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

void nativeContextDestroy(JNIEnv*, jclass,
                                                          jlong handle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(handle);
    if (ctx) eliza_inference_destroy(ctx);
}

#if ELIZA_VOICE_JNI_FULL

// ── VAD direct ops (evidence / self-test) ────────────────────────────────

jlong nativeVadOpen(JNIEnv* env, jclass,
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
// probabilities as a Java float[] (length samples/512). Zero per-window
// bridge calls — the whole batch runs natively.
jfloatArray nativeVadProcessBatch(JNIEnv* env, jclass,
                                                           jlong vadHandle,
                                                           jfloatArray jPcm) {
    auto* vad = reinterpret_cast<EliVad*>(vadHandle);
    const std::vector<float> pcm = read_float_array(env, jPcm);
    if (pcm.size() % kVadWindow != 0) {
        throw_runtime(env, "vad_process: PCM must contain complete 512-sample windows", nullptr);
        return nullptr;
    }
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

void nativeVadReset(JNIEnv*, jclass,
                                                    jlong vadHandle) {
    auto* vad = reinterpret_cast<EliVad*>(vadHandle);
    char* outError = nullptr;
    eliza_inference_vad_reset(vad, &outError);
    if (outError) std::free(outError);
}

void nativeVadClose(JNIEnv*, jclass,
                                                    jlong vadHandle) {
    eliza_inference_vad_close(reinterpret_cast<EliVad*>(vadHandle));
}

// ── Wake-word ops ────────────────────────────────────────────────────────

jlong nativeWakewordOpen(JNIEnv* env, jclass,
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
// Java float[] (length samples/1280).
jfloatArray nativeWakewordScoreBatch(JNIEnv* env,
                                                              jclass,
                                                              jlong wakeHandle,
                                                              jfloatArray jPcm) {
    auto* wake = reinterpret_cast<EliWakeWord*>(wakeHandle);
    const std::vector<float> pcm = read_float_array(env, jPcm);
    if (pcm.size() % kWakeFrame != 0) {
        throw_runtime(env, "wakeword_score: PCM must contain complete 1280-sample frames", nullptr);
        return nullptr;
    }
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

void nativeWakewordReset(JNIEnv*, jclass,
                                                         jlong wakeHandle) {
    auto* wake = reinterpret_cast<EliWakeWord*>(wakeHandle);
    char* outError = nullptr;
    eliza_inference_wakeword_reset(wake, &outError);
    if (outError) std::free(outError);
}

void nativeWakewordClose(JNIEnv*, jclass,
                                                         jlong wakeHandle) {
    eliza_inference_wakeword_close(reinterpret_cast<EliWakeWord*>(wakeHandle));
}

// ── Speaker encoder ops ──────────────────────────────────────────────────

jlong nativeSpeakerOpen(JNIEnv* env, jclass,
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
jfloatArray nativeSpeakerEmbed(JNIEnv* env, jclass,
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

void nativeSpeakerClose(JNIEnv*, jclass,
                                                        jlong spHandle) {
    eliza_inference_speaker_close(reinterpret_cast<EliSpeaker*>(spHandle));
}

// ── Diarizer ops ─────────────────────────────────────────────────────────

jlong nativeDiarizOpen(JNIEnv* env, jclass,
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
jbyteArray nativeDiarizSegment(JNIEnv* env, jclass,
                                                         jlong diHandle,
                                                         jfloatArray jPcm) {
    auto* di = reinterpret_cast<EliDiariz*>(diHandle);
    std::vector<float> pcm = read_float_array(env, jPcm);
    if (pcm.size() > kDiarizWindow) {
        throw_runtime(env, "diariz_segment: at most 80000 samples per model window", nullptr);
        return nullptr;
    }
    // A short direct window is zero-padded; oversized input rejects explicitly.
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

void nativeDiarizClose(JNIEnv*, jclass,
                                                       jlong diHandle) {
    eliza_inference_diariz_close(reinterpret_cast<EliDiariz*>(diHandle));
}

// ── Native streaming pipeline (the hot-loop owner) ───────────────────────

// Open a pipeline session on a context. VAD, speaker and diariz are required;
// failure releases already-opened classifiers and rejects the request.
jlong nativePipelineOpen(JNIEnv* env, jclass,
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
jstring nativePipelineProcess(JNIEnv* env, jclass,
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
jstring nativePipelineFlush(JNIEnv* env, jclass,
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
jfloatArray nativePipelineTurnEmbedding(JNIEnv* env,
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
jbyteArray nativePipelineTurnLabels(JNIEnv* env,
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
jfloatArray nativePipelineTurnPcm(JNIEnv* env,
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

void nativePipelineReset(JNIEnv*, jclass,
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

void nativePipelineClose(JNIEnv*, jclass,
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
jstring nativePipelineSelfTest(JNIEnv* env, jclass,
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
        if (eliza_inference_vad_reset(s->vad, &outError) != ELIZA_OK) {
            cleanup_session_for_selftest(s, ctx);
            throw_runtime(env, "pipelineSelfTest: reset", outError);
            return nullptr;
        }
        if (!finalize_turn(s, &outError)) {
            cleanup_session_for_selftest(s, ctx);
            throw_runtime(env, "pipelineSelfTest: finalize", outError);
            return nullptr;
        }
        for (auto& t : s->turns) allTurns.push_back(t);
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
jstring nativeWakewordSelfTest(JNIEnv* env, jclass,
                                                            jstring jBundleDir,
                                                            jfloatArray jPos,
                                                            jfloatArray jNeg) {
    const std::vector<float> positive = read_float_array(env, jPos);
    const std::vector<float> negative = read_float_array(env, jNeg);
    if (positive.empty() || negative.empty() ||
        positive.size() % kWakeFrame != 0 || negative.size() % kWakeFrame != 0) {
        throw_runtime(env, "wakewordSelfTest: both clips must contain nonempty complete 1280-sample frames", nullptr);
        return nullptr;
    }
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
    auto cleanup = [&]() {
        eliza_inference_wakeword_close(wake);
        eliza_inference_destroy(ctx);
    };
    auto scoreMax = [&](const std::vector<float>& pcm, float& maxP) -> bool {
        for (size_t off = 0; off < pcm.size(); off += kWakeFrame) {
            float p = -1.0f;
            if (eliza_inference_wakeword_score(wake, pcm.data() + off,
                                               kWakeFrame, &p, &outError) != ELIZA_OK) {
                return false;
            }
            if (!std::isfinite(p) || p < 0.0f || p > 1.0f) {
                throw_runtime(env, "wakewordSelfTest: invalid probability", outError);
                outError = nullptr;
                return false;
            }
            maxP = std::max(maxP, p);
        }
        return true;
    };
    float posMax = 0.0f, negMax = 0.0f;
    if (!scoreMax(positive, posMax)) {
        cleanup();
        if (!env->ExceptionCheck()) throw_runtime(env, "wakewordSelfTest: positive score", outError);
        return nullptr;
    }
    if (eliza_inference_wakeword_reset(wake, &outError) != ELIZA_OK) {
        cleanup();
        throw_runtime(env, "wakewordSelfTest: reset", outError);
        return nullptr;
    }
    if (!scoreMax(negative, negMax)) {
        cleanup();
        if (!env->ExceptionCheck()) throw_runtime(env, "wakewordSelfTest: negative score", outError);
        return nullptr;
    }
    cleanup();
    LOGI("WAKEWORD SELFTEST: posMax=%.4f negMax=%.4f (pos should >> neg)",
         posMax, negMax);
    std::string j = "{\"posMax\":" + std::to_string(posMax) +
                    ",\"negMax\":" + std::to_string(negMax) + "}";
    return to_jstring(env, j);
}

// ── VAD self-test (Phase 3a, retained for the existing harness) ──────────

jstring nativeVadSelfTest(JNIEnv* env, jclass,
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

jint nativeLlmStreamSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_llm_stream_supported());
}

jint nativeEmbedSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_embed_supported());
}

jint nativeEotSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_llm_eot_supported());
}

// Tokenize text -> int[] token ids. addSpecial adds BOS; parseSpecial renders
// special tokens (<|im_start|> etc.) from the input.
jintArray nativeTokenize(JNIEnv* env, jclass,
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
jfloatArray nativeEmbed(JNIEnv* env, jclass,
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

jlong nativeContextCreateUtf8(JNIEnv* env, jclass, jbyteArray input) {
    std::string bundle;
    if (!read_utf8(env, input, "embedding", bundle)) return 0;
    if (bundle.empty() || bundle.find('\0') != std::string::npos) {
        throw_runtime(env, "embedding: invalid bundle path", nullptr);
        return 0;
    }
    char* error = nullptr;
    auto* context = eliza_inference_create(bundle.c_str(), &error);
    if (!context) {
        throw_runtime(env, "embedding: context creation failed", error);
        return 0;
    }
    return reinterpret_cast<jlong>(context);
}

static jintArray tokenize_embedding_utf8(JNIEnv* env, jlong handle, jbyteArray input, bool parse_special) {
    std::string text;
    if (!read_utf8(env, input, "embedding", text)) return nullptr;
    int* tokens = nullptr;
    size_t count = 0;
    char* error = nullptr;
    const int rc = eliza_inference_tokenize(reinterpret_cast<EliInferenceContext*>(handle),
        text.data(), text.size(), 1, parse_special ? 1 : 0, &tokens, &count, &error);
    if (rc != ELIZA_OK) {
        if (tokens) eliza_inference_free_tokens(tokens);
        throw_runtime(env, "embedding: tokenize failed", error);
        return nullptr;
    }
    jintArray result = env->NewIntArray(static_cast<jsize>(count));
    if (result && count > 0) env->SetIntArrayRegion(result, 0, static_cast<jsize>(count),
        reinterpret_cast<const jint*>(tokens));
    if (tokens) eliza_inference_free_tokens(tokens);
    return result;
}

static jfloatArray embed_utf8(JNIEnv* env, jlong handle, jbyteArray input, jint pooling, bool with_options, bool parse_special) {
    std::string text;
    if (!read_utf8(env, input, "embedding", text)) return nullptr;
    std::vector<float> values(384);
    int dimension = 0;
    char* error = nullptr;
    int rc;
    if (with_options) {
        // This additive entrypoint is absent in older externally supplied fused
        // libraries. Never substitute legacy embedding: its token semantics
        // differ and it cannot uphold complete-input admission.
        using EmbedWithOptions = int (*)(EliInferenceContext*, const char*, size_t,
            int, int, float*, size_t, int*, char**);
        auto embed = reinterpret_cast<EmbedWithOptions>(
            dlsym(RTLD_DEFAULT, "eliza_inference_embed_with_options"));
        if (!embed) {
            throw_runtime(env, "embedding: installed fused inference library lacks complete-input embedding; install ABI 16 or newer", nullptr);
            return nullptr;
        }
        rc = embed(reinterpret_cast<EliInferenceContext*>(handle), text.data(),
            text.size(), pooling, parse_special ? 1 : 0, values.data(),
            values.size(), &dimension, &error);
    } else {
        rc = eliza_inference_embed(reinterpret_cast<EliInferenceContext*>(handle),
            text.data(), text.size(), pooling, values.data(), values.size(), &dimension, &error);
    }
    if (rc != ELIZA_OK) {
        throw_runtime(env, "embedding: encode failed", error);
        return nullptr;
    }
    if (dimension != 384) {
        throw_runtime(env, "embedding: BGE dimension mismatch", nullptr);
        return nullptr;
    }
    jfloatArray result = env->NewFloatArray(dimension);
    if (result) env->SetFloatArrayRegion(result, 0, dimension, values.data());
    return result;
}

jintArray nativeTokenizeUtf8(JNIEnv* env, jclass, jlong handle, jbyteArray input) {
    return tokenize_embedding_utf8(env, handle, input, false);
}

jintArray nativeTokenizeWithOptionsUtf8(JNIEnv* env, jclass, jlong handle, jbyteArray input, jboolean parse_special) {
    return tokenize_embedding_utf8(env, handle, input, parse_special == JNI_TRUE);
}

jfloatArray nativeEmbedUtf8(JNIEnv* env, jclass, jlong handle, jbyteArray input, jint pooling) {
    return embed_utf8(env, handle, input, pooling, false, false);
}

jfloatArray nativeEmbedWithOptionsUtf8(JNIEnv* env, jclass, jlong handle, jbyteArray input, jint pooling, jboolean parse_special) {
    return embed_utf8(env, handle, input, pooling, true, parse_special == JNI_TRUE);
}

// End-of-turn score: next-token P(targetToken | tokens) -> float.
jfloat nativeEotScore(JNIEnv* env, jclass,
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
jlong nativeLlmStreamOpen(
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

void nativeLlmStreamPrefill(JNIEnv* env, jclass,
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
jstring nativeLlmStreamNext(JNIEnv* env, jclass,
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

void nativeLlmStreamClose(JNIEnv*, jclass,
                                                          jlong streamHandle) {
    eliza_inference_llm_stream_close(
        reinterpret_cast<EliLlmStream*>(streamHandle));
}

// Reset a persistent stream (clear KV + sampler + counters) for warm reuse.
// Returns 1 on success, 0 if the stream can't be reset (MTP / null).
jint nativeLlmStreamReset(JNIEnv*, jclass,
                                                          jlong streamHandle) {
    const int rc = eliza_inference_llm_stream_reset(
        reinterpret_cast<EliLlmStream*>(streamHandle));
    return static_cast<jint>(rc == ELIZA_OK ? 1 : 0);
}

// Prefix-preserving reset: keep the first nKeep tokens of KV resident, drop the
// rest. Returns the n_keep actually applied (>= 0), or a negative ELIZA_* on a
// NULL / MTP / unopened stream (caller falls back to a full reset + prefill).
jint nativeLlmStreamResetKeep(JNIEnv*, jclass,
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
jstring nativeLlmSelfTest(JNIEnv* env, jclass,
                                                       jstring jBundleDir,
                                                       jstring jPrompt,
                                                       jint maxTokens) {
    const std::string bundleDir = from_jstring(env, jBundleDir);
    const std::string prompt = from_jstring(env, jPrompt);
    if (maxTokens <= 0) {
        throw_runtime(env, "llmSelfTest: missing positive generation boundary", nullptr);
        return nullptr;
    }
    const int genCap = maxTokens;
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
    bool terminal = false;
    int failureRc = 0;
    while (produced < genCap) {
        int32_t toks[256]; char chunk[4096]; size_t nout = 0;
        int32_t dd = 0, da = 0;
        const size_t stepCap = static_cast<size_t>(std::min(256, genCap - produced));
        const int rc = eliza_inference_llm_stream_next(
            s, toks, stepCap, &nout, chunk, sizeof(chunk), &dd, &da, &outError);
        if (rc < 0) {
            failureRc = rc;
            break;
        }
        text += chunk;
        produced += static_cast<int>(nout);
        if (rc == 1) {
            terminal = true;
            break;
        }
    }
    const double t1 = []() {
        timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
        return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
    }();
    eliza_inference_llm_stream_close(s);
    if (tok) eliza_inference_free_tokens(tok);
    eliza_inference_destroy(ctx);

    if (failureRc < 0) {
        throw_runtime(env, "llmSelfTest: stream_next rc=" + std::to_string(failureRc), outError);
        return nullptr;
    }

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
                       std::to_string(tokS) + ",\"text\":\"" + esc +
                       "\",\"finishReason\":\"" +
                       (terminal ? "model_terminal" : "generation_boundary") +
                       "\",\"incomplete\":" + (terminal ? "false" : "true") + "}";
    return to_jstring(env, json);
}

#endif  // ELIZA_VOICE_JNI_FULL

// ── Paradee-8M TTS with native misaki G2P (ABI v17) ──────────────────────
//
// Paradee speaks one English voice at 24 kHz from misaki phonemes. The fused
// library turns text into misaki phonemes itself (lexicon + rules, eSpeak NG
// only for out-of-lexicon words when its data is given), so no caller needs a
// phonemizer. The model stays loaded on the context; nativeParadeeLoad is
// cheap when the same files are already loaded.

jint nativeParadeeSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_paradee_supported());
}

jint nativeParadeeLoad(JNIEnv* env, jclass, jlong ctxHandle, jstring jGguf,
                       jstring jLexicon, jstring jEspeakDir) {
    auto* ctx = voice_context(env, ctxHandle, "paradee_load");
    if (!ctx) return ELIZA_ERR_INVALID_ARG;
    const std::string gguf = from_jstring(env, jGguf);
    const std::string lexicon = from_jstring(env, jLexicon);
    const std::string espeak = from_jstring(env, jEspeakDir);
    if (gguf.empty() || lexicon.empty()) {
        throw_voice(env, "paradee_load: model and lexicon paths", ELIZA_ERR_INVALID_ARG, nullptr);
        return ELIZA_ERR_INVALID_ARG;
    }
    char* err = nullptr;
    const int rc = eliza_inference_paradee_load(
        ctx, gguf.c_str(), lexicon.c_str(), espeak.empty() ? nullptr : espeak.c_str(), &err);
    if (rc != ELIZA_OK) {
        throw_voice(env, "paradee_load", rc, err);
        return rc;
    }
    return ELIZA_OK;
}

jint nativeParadeeSampleRate(JNIEnv*, jclass, jlong ctxHandle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    return ctx ? eliza_inference_paradee_sample_rate(ctx) : ELIZA_ERR_INVALID_ARG;
}

jint nativeParadeeG2pKind(JNIEnv*, jclass, jlong ctxHandle) {
    auto* ctx = reinterpret_cast<EliInferenceContext*>(ctxHandle);
    return ctx ? eliza_inference_paradee_g2p_kind(ctx) : ELIZA_ERR_INVALID_ARG;
}

jstring nativeParadeePhonemize(JNIEnv* env, jclass, jlong ctxHandle, jbyteArray jText) {
    auto* ctx = voice_context(env, ctxHandle, "paradee_phonemize");
    std::string text;
    if (!ctx || !read_utf8(env, jText, "paradee_phonemize", text)) return nullptr;
    char* phonemes = nullptr;
    char* err = nullptr;
    // Returns the phoneme byte length on success.
    const int rc = eliza_inference_paradee_phonemize(ctx, text.data(), text.size(), &phonemes, &err);
    if (rc < 0) {
        if (phonemes) eliza_inference_free_string(phonemes);
        throw_voice(env, "paradee_phonemize", rc, err);
        return nullptr;
    }
    jstring out = utf8_to_jstring(env, phonemes ? phonemes : "", phonemes ? static_cast<size_t>(rc) : 0);
    if (phonemes) eliza_inference_free_string(phonemes);
    return out;
}

jfloatArray nativeParadeeSynthesize(JNIEnv* env, jclass, jlong ctxHandle, jbyteArray jText,
                                    jfloat speed) {
    auto* ctx = voice_context(env, ctxHandle, "paradee_synthesize");
    std::string text;
    if (!ctx || !read_utf8(env, jText, "paradee_synthesize", text)) return nullptr;
    float* pcm = nullptr;
    size_t samples = 0;
    char* err = nullptr;
    const int rc = eliza_inference_paradee_synthesize_alloc(
        ctx, text.data(), text.size(), speed, &pcm, &samples, &err);
    if (rc != ELIZA_OK) {
        eliza_inference_free_pcm(pcm);
        throw_voice(env, "paradee_synthesize", rc, err);
        return nullptr;
    }
    LOGI("paradee_synthesize: %zu text bytes -> %zu samples", text.size(), samples);
    return take_pcm(env, "paradee_synthesize: no audio", pcm, samples);
}

jfloatArray nativeParadeeSynthesizePhonemes(JNIEnv* env, jclass, jlong ctxHandle,
                                            jbyteArray jPhonemes, jfloat speed) {
    auto* ctx = voice_context(env, ctxHandle, "paradee_synthesize_phonemes");
    std::string phonemes;
    if (!ctx || !read_utf8(env, jPhonemes, "paradee_synthesize_phonemes", phonemes)) return nullptr;
    float* pcm = nullptr;
    size_t samples = 0;
    char* err = nullptr;
    const int rc = eliza_inference_paradee_synthesize_phonemes_alloc(
        ctx, phonemes.data(), phonemes.size(), speed, &pcm, &samples, &err);
    if (rc != ELIZA_OK) {
        eliza_inference_free_pcm(pcm);
        throw_voice(env, "paradee_synthesize_phonemes", rc, err);
        return nullptr;
    }
    LOGI("paradee_synthesize_phonemes: %zu phoneme bytes -> %zu samples", phonemes.size(), samples);
    return take_pcm(env, "paradee_synthesize_phonemes: no audio", pcm, samples);
}

struct ParadeeStreamSink {
    JNIEnv * env;
    jobject sink;
    jmethodID method;
};

static int paradee_stream_chunk(const float * pcm, size_t samples, int final, void * user) {
    auto & target = *static_cast<ParadeeStreamSink *>(user);
    JNIEnv * env = target.env;
    if (env->ExceptionCheck()) return 1;
    if (samples > 24000 || (samples && !pcm)) {
        throw_voice(env, "paradee stream: invalid PCM window", ELIZA_ERR_FFI_FAULT, nullptr);
        return 1;
    }
    jfloatArray chunk = env->NewFloatArray(static_cast<jsize>(samples));
    if (!chunk) return 1;
    if (samples) env->SetFloatArrayRegion(chunk, 0, static_cast<jsize>(samples), pcm);
    jboolean accepted = JNI_FALSE;
    if (!env->ExceptionCheck()) accepted = env->CallBooleanMethod(target.sink, target.method, chunk, final ? JNI_TRUE : JNI_FALSE);
    env->DeleteLocalRef(chunk);
    return env->ExceptionCheck() || accepted != JNI_TRUE ? 1 : 0;
}

jint nativeParadeeStreamSupported(JNIEnv *, jclass) {
    return eliza_inference_paradee_stream_supported();
}

void nativeParadeeSynthesizeStream(JNIEnv * env, jclass, jlong ctxHandle,
        jbyteArray text, jfloat speed, jobject sink) {
    auto * ctx = voice_context(env, ctxHandle, "paradee stream");
    if (!ctx) return;
    if (!sink) {
        throw_voice(env, "paradee stream: missing sink", ELIZA_ERR_INVALID_ARG, nullptr);
        return;
    }
    std::string utf8;
    if (!read_utf8(env, text, "paradee stream", utf8)) return;
    jclass type = env->GetObjectClass(sink);
    if (!type) return;
    jmethodID method = env->GetMethodID(type, "onChunk", "([FZ)Z");
    env->DeleteLocalRef(type);
    if (!method || env->ExceptionCheck()) return;
    ParadeeStreamSink target{env, sink, method};
    char * error = nullptr;
    const int rc = eliza_inference_paradee_synthesize_stream(
        ctx, utf8.data(), utf8.size(), speed, paradee_stream_chunk, &target, &error);
    if (env->ExceptionCheck()) { eliza_inference_free_string(error); return; }
    if (rc != ELIZA_OK) throw_voice(env, "paradee stream", rc, error);
}

// Stop the TTS forward pass running on another thread. The running call
// throws CancellationException. Cancelling nothing is not an error.
jint nativeCancelTts(JNIEnv* env, jclass, jlong ctxHandle) {
    auto* ctx = voice_context(env, ctxHandle, "cancel_tts");
    if (!ctx) return ELIZA_ERR_INVALID_ARG;
    char* err = nullptr;
    const int rc = eliza_inference_cancel_tts(ctx, &err);
    if (rc != ELIZA_OK) throw_voice(env, "cancel_tts", rc, err);
    return rc;
}

// ── Batch ASR (synchronous, VAD-free) ────────────────────────────────────
//
// The DIRECT audio-in/text-out transcribe of the fused lib
// (eliza_inference_asr_transcribe). It acquires the `asr/` weights on the
// context on first use. The bionic host's op="asr" and the paradee-voice
// NativeAsr call this.

jint nativeAsrSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_asr_supported());
}

jstring nativeAsrTranscribe(JNIEnv* env, jclass, jlong ctxHandle, jfloatArray jPcm,
                            jint sampleRate) {
    auto* ctx = voice_context(env, ctxHandle, "asr_transcribe");
    if (!ctx) return nullptr;
    if (!jPcm) {
        throw_voice(env, "asr_transcribe: missing PCM", ELIZA_ERR_INVALID_ARG, nullptr);
        return nullptr;
    }
    // The ASR weights are a voice-only region that must be acquired before
    // transcribe. Idempotent when already acquired; reloads after an evict.
    char* acqErr = nullptr;
    const int acquired = eliza_inference_mmap_acquire(ctx, "asr", &acqErr);
    if (acquired != ELIZA_OK) {
        throw_voice(env, "asr mmap_acquire", acquired, acqErr);
        return nullptr;
    }
    const std::vector<float> pcm = read_float_array(env, jPcm);
    // Caller-owned storage is required by the ABI. Saturation is rejected below
    // so this boundary never returns a transcript prefix as a successful result.
    std::vector<char> out(1024 * 1024, 0);
    char* err = nullptr;
    const int rc = eliza_inference_asr_transcribe(
        ctx, pcm.data(), pcm.size(), sampleRate > 0 ? sampleRate : kSampleRate,
        out.data(), out.size(), &err);
    if (rc < 0) {
        throw_voice(env, "asr_transcribe", rc, err);
        return nullptr;
    }
    if (static_cast<size_t>(rc) >= out.size() - 1 || out.back() != 0) {
        throw_voice(env, "asr_transcribe: transcript capture saturated", ELIZA_ERR_OOM, nullptr);
        return nullptr;
    }
    LOGI("asr_transcribe: %zu samples @ %d Hz -> %d transcript bytes", pcm.size(),
         (int)sampleRate, rc);
    return utf8_to_jstring(env, out.data(), static_cast<size_t>(rc));
}

// Stop a transcribe running on another thread; it throws
// CancellationException. Cancelling nothing is not an error.
jint nativeAsrCancel(JNIEnv* env, jclass, jlong ctxHandle) {
    auto* ctx = voice_context(env, ctxHandle, "asr_cancel");
    if (!ctx) return ELIZA_ERR_INVALID_ARG;
    char* err = nullptr;
    const int rc = eliza_inference_asr_cancel(ctx, &err);
    if (rc != ELIZA_OK) throw_voice(env, "asr_cancel", rc, err);
    return rc;
}

// ── Streaming ASR (Parakeet-TDT backend, ABI v18 fork) ───────────────────
//
// open → feed* → partial* → finish → close, on a context whose "asr" region
// holds a parakeet-tdt GGUF (Phonon-2 under <bundle>/asr/). The Java handle
// is a bridge-owned AsrStream that remembers the context, so cancel only
// needs the stream handle. Thread rules (from the ABI): feed only buffers and
// may run on the audio thread while partial/finish decode on another;
// partial/finish/cancel never race close on the same handle — the caller
// closes once, after the last call returns. Token ids are never returned.

struct AsrStream {
    EliInferenceContext* ctx;
    EliAsrStream* stream;
};

// Running transcripts are short; 64 KiB covers well over the 60 s cap.
constexpr size_t kAsrStreamTextBytes = 64 * 1024;

AsrStream* asr_stream(JNIEnv* env, jlong handle, const char* stage) {
    auto* s = reinterpret_cast<AsrStream*>(handle);
    if (!s || !s->stream) throw_voice(env, stage, ELIZA_ERR_INVALID_ARG, nullptr);
    return s;
}

// 1 when this library can stream: the parakeet backend is compiled in and
// some context has it loaded (0 before the first "asr" acquire and after an
// evict).
jint nativeAsrStreamSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_asr_stream_supported());
}

// Acquire the "asr" region (idempotent) and open a stream for PCM at
// `sampleRate` Hz (the library resamples). Throws when the bundle's ASR is
// not the parakeet backend; callers then keep the batch path.
jlong nativeAsrStreamOpen(JNIEnv* env, jclass, jlong ctxHandle, jint sampleRate) {
    auto* ctx = voice_context(env, ctxHandle, "asr_stream_open");
    if (!ctx) return 0;
    if (sampleRate <= 0) {
        throw_voice(env, "asr_stream_open: sample rate", ELIZA_ERR_INVALID_ARG, nullptr);
        return 0;
    }
    char* acqErr = nullptr;
    const int acquired = eliza_inference_mmap_acquire(ctx, "asr", &acqErr);
    if (acquired != ELIZA_OK) {
        throw_voice(env, "asr mmap_acquire", acquired, acqErr);
        return 0;
    }
    auto* wrapper = new (std::nothrow) AsrStream{ctx, nullptr};
    if (!wrapper) {
        throw_voice(env, "asr_stream_open", ELIZA_ERR_OOM, nullptr);
        return 0;
    }
    char* err = nullptr;
    wrapper->stream = eliza_inference_asr_stream_open(ctx, static_cast<int>(sampleRate), &err);
    if (!wrapper->stream) {
        delete wrapper;
        // Not the parakeet backend (or evicted): a rejected request, not a fault.
        throw_voice(env, "asr_stream_open", ELIZA_ERR_INVALID_ARG, err);
        return 0;
    }
    LOGI("asr_stream_open: %d Hz", (int)sampleRate);
    return reinterpret_cast<jlong>(wrapper);
}

// Buffer fp32 mono PCM at the stream's rate. Never decodes, so it is safe on
// the audio thread. Returns the samples consumed.
jint nativeAsrStreamFeed(JNIEnv* env, jclass, jlong streamHandle, jfloatArray jPcm) {
    auto* s = asr_stream(env, streamHandle, "asr_stream_feed");
    if (!s) return ELIZA_ERR_INVALID_ARG;
    if (!jPcm) {
        throw_voice(env, "asr_stream_feed: missing PCM", ELIZA_ERR_INVALID_ARG, nullptr);
        return ELIZA_ERR_INVALID_ARG;
    }
    const std::vector<float> pcm = read_float_array(env, jPcm);
    if (pcm.empty()) return 0;
    char* err = nullptr;
    const int rc = eliza_inference_asr_stream_feed(s->stream, pcm.data(), pcm.size(), &err);
    if (rc < 0) throw_voice(env, "asr_stream_feed", rc, err);
    return rc;
}

jstring asr_stream_text(JNIEnv* env, jlong streamHandle, bool finish) {
    const char* stage = finish ? "asr_stream_finish" : "asr_stream_partial";
    auto* s = asr_stream(env, streamHandle, stage);
    if (!s) return nullptr;
    std::vector<char> out(kAsrStreamTextBytes, 0);
    size_t nTokens = 0;
    char* err = nullptr;
    const int rc = finish
        ? eliza_inference_asr_stream_finish(s->stream, out.data(), out.size(), nullptr, &nTokens, &err)
        : eliza_inference_asr_stream_partial(s->stream, out.data(), out.size(), nullptr, &nTokens, &err);
    if (rc < 0) {
        throw_voice(env, stage, rc, err);
        return nullptr;
    }
    const size_t n = std::min(static_cast<size_t>(rc), out.size() - 1);
    return utf8_to_jstring(env, out.data(), n);
}

// Decode what has been fed and return the running transcript.
jstring nativeAsrStreamPartial(JNIEnv* env, jclass, jlong streamHandle) {
    return asr_stream_text(env, streamHandle, false);
}

// Drain buffered audio, run the last decode and return the final transcript.
// Later feeds fail; the handle stays valid until close.
jstring nativeAsrStreamFinish(JNIEnv* env, jclass, jlong streamHandle) {
    return asr_stream_text(env, streamHandle, true);
}

// Stop a partial/finish decoding on another thread; it throws
// CancellationException. Uses the stream's context, so it also stops a batch
// transcribe on that context. Cancelling nothing is not an error.
jint nativeAsrStreamCancel(JNIEnv* env, jclass, jlong streamHandle) {
    auto* s = asr_stream(env, streamHandle, "asr_stream_cancel");
    if (!s) return ELIZA_ERR_INVALID_ARG;
    char* err = nullptr;
    const int rc = eliza_inference_asr_cancel(s->ctx, &err);
    if (rc != ELIZA_OK) throw_voice(env, "asr_stream_cancel", rc, err);
    return rc;
}

// Free the stream. Idempotent on 0. Must not race other calls on the handle.
void nativeAsrStreamClose(JNIEnv*, jclass, jlong streamHandle) {
    auto* s = reinterpret_cast<AsrStream*>(streamHandle);
    if (!s) return;
    eliza_inference_asr_stream_close(s->stream);
    delete s;
}

// ── Voice memory regions ─────────────────────────────────────────────────
//
// Region names are the ABI set ("tts", "asr", "vad", "text", "dflash").
// Evicting "tts" or "asr" frees those weights and keeps the context, so the
// host can answer onTrimMemory without a full reload; the next voice call
// loads them again.

jint nativeMmapAcquire(JNIEnv* env, jclass, jlong ctxHandle, jstring jRegion) {
    auto* ctx = voice_context(env, ctxHandle, "mmap_acquire");
    if (!ctx) return ELIZA_ERR_INVALID_ARG;
    const std::string region = from_jstring(env, jRegion);
    char* err = nullptr;
    const int rc = eliza_inference_mmap_acquire(ctx, region.c_str(), &err);
    if (rc != ELIZA_OK) throw_voice(env, "mmap_acquire", rc, err);
    return rc;
}

jint nativeMmapEvict(JNIEnv* env, jclass, jlong ctxHandle, jstring jRegion) {
    auto* ctx = voice_context(env, ctxHandle, "mmap_evict");
    if (!ctx) return ELIZA_ERR_INVALID_ARG;
    const std::string region = from_jstring(env, jRegion);
    char* err = nullptr;
    const int rc = eliza_inference_mmap_evict(ctx, region.c_str(), &err);
    if (rc != ELIZA_OK) throw_voice(env, "mmap_evict", rc, err);
    return rc;
}

#if ELIZA_VOICE_JNI_FULL
// ── mmproj vision (ABI v9) ───────────────────────────────────────────────
jint nativeVisionSupported(JNIEnv*, jclass) {
    return static_cast<jint>(eliza_inference_vision_supported());
}

// Describe a raw PNG/JPEG/WebP image with the resident TEXT model + an mmproj
// projector (eliza_inference_describe_image). The bionic host's op="image"
// calls this so the agent's IMAGE_DESCRIPTION delegate runs screen/vision
// recognition fully on-device.
jstring nativeDescribeImage(JNIEnv* env, jclass,
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

#endif  // ELIZA_VOICE_JNI_FULL

// ── Registration ─────────────────────────────────────────────────────────

#define ELIZA_NATIVE(name, signature) \
    JNINativeMethod { const_cast<char*>(#name), const_cast<char*>(signature), reinterpret_cast<void*>(name) }

const JNINativeMethod kVoiceMethods[] = {
    ELIZA_NATIVE(nativeVoiceAbiVersion, "()Ljava/lang/String;"),
    ELIZA_NATIVE(nativeContextCreate, "(Ljava/lang/String;)J"),
    ELIZA_NATIVE(nativeContextDestroy, "(J)V"),
    ELIZA_NATIVE(nativeParadeeSupported, "()I"),
    ELIZA_NATIVE(nativeParadeeLoad, "(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I"),
    ELIZA_NATIVE(nativeParadeeSampleRate, "(J)I"),
    ELIZA_NATIVE(nativeParadeeG2pKind, "(J)I"),
    ELIZA_NATIVE(nativeParadeePhonemize, "(J[B)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeParadeeSynthesize, "(J[BF)[F"),
    ELIZA_NATIVE(nativeParadeeStreamSupported, "()I"),
    ELIZA_NATIVE(nativeParadeeSynthesizeStream, "(J[BFLjava/lang/Object;)V"),
    ELIZA_NATIVE(nativeParadeeSynthesizePhonemes, "(J[BF)[F"),
    ELIZA_NATIVE(nativeCancelTts, "(J)I"),
    ELIZA_NATIVE(nativeAsrSupported, "()I"),
    ELIZA_NATIVE(nativeAsrTranscribe, "(J[FI)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeAsrCancel, "(J)I"),
    ELIZA_NATIVE(nativeAsrStreamSupported, "()I"),
    ELIZA_NATIVE(nativeAsrStreamOpen, "(JI)J"),
    ELIZA_NATIVE(nativeAsrStreamFeed, "(J[F)I"),
    ELIZA_NATIVE(nativeAsrStreamPartial, "(J)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeAsrStreamFinish, "(J)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeAsrStreamCancel, "(J)I"),
    ELIZA_NATIVE(nativeAsrStreamClose, "(J)V"),
    ELIZA_NATIVE(nativeMmapAcquire, "(JLjava/lang/String;)I"),
    ELIZA_NATIVE(nativeMmapEvict, "(JLjava/lang/String;)I"),
};

#if ELIZA_VOICE_JNI_FULL
const JNINativeMethod kHostMethods[] = {
    ELIZA_NATIVE(nativeVadSupported, "()I"),
    ELIZA_NATIVE(nativeWakewordSupported, "()I"),
    ELIZA_NATIVE(nativeSpeakerSupported, "()I"),
    ELIZA_NATIVE(nativeDiarizSupported, "()I"),
    ELIZA_NATIVE(nativeVadOpen, "(J)J"),
    ELIZA_NATIVE(nativeVadProcessBatch, "(J[F)[F"),
    ELIZA_NATIVE(nativeVadReset, "(J)V"),
    ELIZA_NATIVE(nativeVadClose, "(J)V"),
    ELIZA_NATIVE(nativeWakewordOpen, "(JLjava/lang/String;)J"),
    ELIZA_NATIVE(nativeWakewordScoreBatch, "(J[F)[F"),
    ELIZA_NATIVE(nativeWakewordReset, "(J)V"),
    ELIZA_NATIVE(nativeWakewordClose, "(J)V"),
    ELIZA_NATIVE(nativeSpeakerOpen, "(JLjava/lang/String;)J"),
    ELIZA_NATIVE(nativeSpeakerEmbed, "(J[F)[F"),
    ELIZA_NATIVE(nativeSpeakerClose, "(J)V"),
    ELIZA_NATIVE(nativeDiarizOpen, "(JLjava/lang/String;)J"),
    ELIZA_NATIVE(nativeDiarizSegment, "(J[F)[B"),
    ELIZA_NATIVE(nativeDiarizClose, "(J)V"),
    ELIZA_NATIVE(nativePipelineOpen, "(J)J"),
    ELIZA_NATIVE(nativePipelineProcess, "(J[F)Ljava/lang/String;"),
    ELIZA_NATIVE(nativePipelineFlush, "(J)Ljava/lang/String;"),
    ELIZA_NATIVE(nativePipelineTurnEmbedding, "(JI)[F"),
    ELIZA_NATIVE(nativePipelineTurnLabels, "(JI)[B"),
    ELIZA_NATIVE(nativePipelineTurnPcm, "(JI)[F"),
    ELIZA_NATIVE(nativePipelineReset, "(J)V"),
    ELIZA_NATIVE(nativePipelineClose, "(J)V"),
    ELIZA_NATIVE(nativeVadSelfTest, "(Ljava/lang/String;)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeWakewordSelfTest, "(Ljava/lang/String;[F[F)Ljava/lang/String;"),
    ELIZA_NATIVE(nativePipelineSelfTest, "(Ljava/lang/String;[FI)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeLlmStreamSupported, "()I"),
    ELIZA_NATIVE(nativeEmbedSupported, "()I"),
    ELIZA_NATIVE(nativeEotSupported, "()I"),
    ELIZA_NATIVE(nativeTokenize, "(JLjava/lang/String;ZZ)[I"),
    ELIZA_NATIVE(nativeEmbed, "(JLjava/lang/String;I)[F"),
    ELIZA_NATIVE(nativeContextCreateUtf8, "([B)J"),
    ELIZA_NATIVE(nativeTokenizeUtf8, "(J[B)[I"),
    ELIZA_NATIVE(nativeEmbedUtf8, "(J[BI)[F"),
    ELIZA_NATIVE(nativeTokenizeWithOptionsUtf8, "(J[BZ)[I"),
    ELIZA_NATIVE(nativeEmbedWithOptionsUtf8, "(J[BIZ)[F"),
    ELIZA_NATIVE(nativeEotScore, "(J[II)F"),
    ELIZA_NATIVE(nativeLlmStreamOpen, "(JIFFIILjava/lang/String;)J"),
    ELIZA_NATIVE(nativeLlmStreamPrefill, "(J[I)V"),
    ELIZA_NATIVE(nativeLlmStreamNext, "(JI)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeLlmStreamClose, "(J)V"),
    ELIZA_NATIVE(nativeLlmStreamReset, "(J)I"),
    ELIZA_NATIVE(nativeLlmStreamResetKeep, "(JI)I"),
    ELIZA_NATIVE(nativeLlmSelfTest, "(Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;"),
    ELIZA_NATIVE(nativeVisionSupported, "()I"),
    ELIZA_NATIVE(nativeDescribeImage, "(J[BLjava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
};
#endif  // ELIZA_VOICE_JNI_FULL

#undef ELIZA_NATIVE

// Register one method at a time so a failure names the exact method. A class
// without one of these natives fails the whole library load.
bool register_natives(JNIEnv* env, jclass cls, const JNINativeMethod* methods, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        if (env->RegisterNatives(cls, &methods[i], 1) != JNI_OK || env->ExceptionCheck()) {
            env->ExceptionClear();
            LOGE("RegisterNatives failed: %s has no native %s%s", ELIZA_VOICE_JNI_CLASS,
                 methods[i].name, methods[i].signature);
            return false;
        }
    }
    return true;
}

}  // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK || !env) {
        LOGE("JNI_OnLoad: no JNI 1.6 environment");
        return JNI_ERR;
    }
    jclass cls = env->FindClass(ELIZA_VOICE_JNI_CLASS);
    if (!cls) {
        env->ExceptionClear();
        LOGE("JNI_OnLoad: class %s not found", ELIZA_VOICE_JNI_CLASS);
        return JNI_ERR;
    }
    bool ok = register_natives(env, cls, kVoiceMethods, sizeof(kVoiceMethods) / sizeof(kVoiceMethods[0]));
#if ELIZA_VOICE_JNI_FULL
    ok = ok && register_natives(env, cls, kHostMethods, sizeof(kHostMethods) / sizeof(kHostMethods[0]));
#endif
    env->DeleteLocalRef(cls);
    if (!ok) return JNI_ERR;
    LOGI("registered %s natives on %s", ELIZA_VOICE_JNI_FULL ? "host" : "voice",
         ELIZA_VOICE_JNI_CLASS);
    return JNI_VERSION_1_6;
}
