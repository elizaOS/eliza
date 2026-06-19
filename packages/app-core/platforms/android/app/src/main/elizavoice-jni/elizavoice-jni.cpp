// elizavoice-jni.cpp
//
// Minimal JNI bridge that proves the fused, NDK/bionic-built
// `libelizainference.so` (the omnivoice `elizainference` target — all four
// voice runtimes fused at ABI v7) loads + runs INSIDE the normal Android APK
// process (ai.elizaos.app, Capacitor/bionic), NOT the separate musl bun agent.
//
// Phase 3a de-risk only: it exposes two native methods —
//   nativeVoiceAbiVersion()  -> eliza_inference_abi_version()  (expect "7")
//   nativeVadSelfTest(bundleDir) -> create + vad_open + vad_process on a
//                                   512-sample test window -> P(speech)
// Phase 3b wires the real pipeline; this bridge only validates the load.
//
// Mirrors the llama-cpp-capacitor JNI host pattern (System.loadLibrary +
// Java_<pkg>_<Class>_<method> exports), but links the fused voice .so instead
// of the text-only llama .so.

#include <jni.h>
#include <android/log.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>

// Public ABI of the fused fork library. The .so is staged into
// jniLibs/arm64-v8a and loaded via System.loadLibrary("elizainference").
#include "eliza-inference-ffi.h"

#define LOG_TAG "ElizaVoiceJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

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

} // namespace

extern "C" {

// Returns the fused library's ABI version string (e.g. "7"). No model needed:
// this is the cheapest proof that the bionic .so resolved + a real
// eliza_inference_* symbol is callable from the app process.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVoiceAbiVersion(JNIEnv* env, jclass /*clazz*/) {
    const char* abi = eliza_inference_abi_version();
    LOGI("eliza_inference_abi_version() = %s", abi ? abi : "(null)");
    return to_jstring(env, abi ? std::string(abi) : std::string());
}

// 1 when this build implements the native Silero VAD backend (ABI v7+), 0 for
// a stub build. Proves the fused VAD runtime is present in the .so.
JNIEXPORT jint JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadSupported(JNIEnv* env, jclass /*clazz*/) {
    int s = eliza_inference_vad_supported();
    LOGI("eliza_inference_vad_supported() = %d", s);
    return (jint) s;
}

// VAD self-test. Runs the full open->process->close path against a bundle on
// disk and returns a JSON-ish status string the JS side can assert on:
//   {"ok":true,"probability":<float>,"abi":"7","supported":1}
// or {"ok":false,"stage":"<stage>","error":"<msg>","abi":"7","supported":<n>}
//
// `bundleDir` must contain `vad/silero-vad-v5.gguf` for the real forward
// graph. When it's missing/empty we still prove the symbol resolves + the
// session lifecycle is callable, and report the structured failure stage
// rather than crashing. The deliverable is the LOAD + a callable voice op in
// the bionic app process; a finite probability needs the GGUF staged on
// device.
JNIEXPORT jstring JNICALL
Java_ai_elizaos_app_ElizaVoiceNative_nativeVadSelfTest(JNIEnv* env, jclass /*clazz*/, jstring jBundleDir) {
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

    if (bundleDir.empty()) {
        return fail("bundle_dir", "empty bundle dir");
    }

    char* outError = nullptr;
    EliInferenceContext* ctx = eliza_inference_create(bundleDir.c_str(), &outError);
    if (ctx == nullptr) {
        std::string err = outError ? std::string(outError) : std::string("create returned null");
        if (outError) std::free(outError);
        return fail("create", err);
    }

    EliVad* vad = eliza_inference_vad_open(ctx, 16000, &outError);
    if (vad == nullptr) {
        std::string err = outError ? std::string(outError) : std::string("vad_open returned null");
        if (outError) std::free(outError);
        eliza_inference_destroy(ctx);
        return fail("vad_open", err);
    }

    // 512-sample fp32 mono window. A deterministic 200 Hz tone at 16 kHz
    // exercises the real forward graph end-to-end (any finite probability in
    // [0,1] proves the runtime ran; we do not assert a speech/non-speech
    // class here — that is Phase 3b).
    std::vector<float> pcm(512);
    for (size_t i = 0; i < pcm.size(); ++i) {
        pcm[i] = 0.25f * std::sin(2.0 * M_PI * 200.0 * (double) i / 16000.0);
    }

    float probability = -1.0f;
    int rc = eliza_inference_vad_process(vad, pcm.data(), pcm.size(), &probability, &outError);
    if (rc != ELIZA_OK) {
        std::string err = outError ? std::string(outError) : ("rc=" + std::to_string(rc));
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
    LOGI("nativeVadSelfTest ok: probability=%f abi=%s supported=%d",
         probability, abiStr.c_str(), supported);
    return to_jstring(env, j);
}

} // extern "C"
