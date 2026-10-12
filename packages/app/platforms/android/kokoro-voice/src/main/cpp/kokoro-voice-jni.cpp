// SPDX-License-Identifier: MIT
// JNI surface of ai.eliza.kokoro.KokoroVoice: eSpeak NG phonemes into the
// Kokoro-82M head of libelizainference. No agent, server, or network.

#include <jni.h>
#include <android/log.h>

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "eliza-inference-ffi.h"
#include "kokoro-g2p.h"

#define LOG_TAG "KokoroVoice"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

namespace {

// Kokoro reads at most 510 phoneme ids in one pass. Keep a small margin for
// symbols that map to more than one id.
constexpr size_t kMaxPhraseSymbols = 500;
// Kokoro v1.0 voice presets are [510, 256] fp32 style rows.
constexpr int kStyleDim = 256;

// Java passes standard UTF-8 bytes (String.getBytes(UTF_8)), not JNI
// modified UTF-8, so supplementary characters reach eSpeak intact.
std::string utf8(JNIEnv * env, jbyteArray value) {
    if (value == nullptr) return std::string();
    const jsize length = env->GetArrayLength(value);
    std::string out(static_cast<size_t>(length), '\0');
    env->GetByteArrayRegion(value, 0, length, reinterpret_cast<jbyte *>(out.data()));
    return out;
}

void throw_java(JNIEnv * env, const char * type, const std::string & message, char * native_error) {
    std::string text = message;
    if (native_error != nullptr) {
        text += ": ";
        text += native_error;
        std::free(native_error);
    }
    jclass cls = env->FindClass(type);
    if (cls != nullptr) env->ThrowNew(cls, text.c_str());
}

EliInferenceContext * context(jlong handle) {
    return reinterpret_cast<EliInferenceContext *>(handle);
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_ai_eliza_kokoro_KokoroVoice_nativeOpen(
    JNIEnv * env, jclass, jbyteArray jModelDir, jbyteArray jModel, jbyteArray jVoice,
    jbyteArray jEspeakRoot) {
    std::string error;
    const std::string espeak_root = utf8(env, jEspeakRoot);
    if (!espeak_root.empty() && !eliza_kokoro_voice::g2p_init(espeak_root, &error)) {
        throw_java(env, "java/io/IOException", error, nullptr);
        return 0;
    }
    if (eliza_inference_kokoro_supported() != 1) {
        throw_java(env, "java/lang/IllegalStateException",
                   "libelizainference was built without Kokoro (LLAMA_BUILD_KOKORO=OFF)", nullptr);
        return 0;
    }
    char * native_error = nullptr;
    const std::string model_dir = utf8(env, jModelDir);
    EliInferenceContext * ctx = eliza_inference_create(model_dir.c_str(), &native_error);
    if (ctx == nullptr) {
        throw_java(env, "java/io/IOException", "inference context", native_error);
        return 0;
    }
    native_error = nullptr;
    const std::string model = utf8(env, jModel);
    const std::string voice = utf8(env, jVoice);
    if (eliza_inference_kokoro_load(ctx, model.c_str(), voice.c_str(), kStyleDim, &native_error) != 0) {
        eliza_inference_destroy(ctx);
        throw_java(env, "java/io/IOException", "Kokoro model load", native_error);
        return 0;
    }
    LOGI("Kokoro loaded: abi=%s sampleRate=%d", eliza_inference_abi_version(),
         eliza_inference_kokoro_sample_rate(ctx));
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL Java_ai_eliza_kokoro_KokoroVoice_nativeClose(JNIEnv *, jclass, jlong handle) {
    eliza_inference_destroy(context(handle));
}

JNIEXPORT jint JNICALL Java_ai_eliza_kokoro_KokoroVoice_nativeSampleRate(JNIEnv *, jclass, jlong handle) {
    return eliza_inference_kokoro_sample_rate(context(handle));
}

JNIEXPORT jobjectArray JNICALL Java_ai_eliza_kokoro_KokoroVoice_nativePhonemize(
    JNIEnv * env, jclass, jbyteArray jText) {
    std::string error;
    const std::vector<std::string> phrases =
        eliza_kokoro_voice::g2p_phrases(utf8(env, jText), kMaxPhraseSymbols, &error);
    if (phrases.empty()) {
        throw_java(env, "java/lang/IllegalArgumentException", error, nullptr);
        return nullptr;
    }
    jobjectArray out = env->NewObjectArray(static_cast<jsize>(phrases.size()),
                                           env->FindClass("java/lang/String"), nullptr);
    if (out == nullptr) return nullptr;
    for (size_t i = 0; i < phrases.size(); ++i) {
        jstring item = env->NewStringUTF(phrases[i].c_str());
        if (item == nullptr) return nullptr;
        env->SetObjectArrayElement(out, static_cast<jsize>(i), item);
        env->DeleteLocalRef(item);
    }
    return out;
}

JNIEXPORT jfloatArray JNICALL Java_ai_eliza_kokoro_KokoroVoice_nativeSynthesizeIpa(
    JNIEnv * env, jclass, jlong handle, jbyteArray jIpa, jfloat speed) {
    const std::string ipa = utf8(env, jIpa);
    float * pcm = nullptr;
    size_t samples = 0;
    char * native_error = nullptr;
    if (eliza_inference_kokoro_synthesize_ipa_alloc(context(handle), ipa.c_str(), ipa.size(), speed,
                                                    &pcm, &samples, &native_error) != 0) {
        throw_java(env, "java/lang/IllegalStateException", "Kokoro synthesis", native_error);
        return nullptr;
    }
    if (pcm == nullptr || samples == 0 || samples > static_cast<size_t>(INT32_MAX)) {
        eliza_inference_free_pcm(pcm);
        throw_java(env, "java/lang/IllegalStateException", "Kokoro returned no audio", nullptr);
        return nullptr;
    }
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(samples));
    if (out != nullptr) env->SetFloatArrayRegion(out, 0, static_cast<jsize>(samples), pcm);
    eliza_inference_free_pcm(pcm);
    return out;
}

}  // extern "C"
