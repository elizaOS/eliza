package ai.eliza.plugins.llama

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Capacitor bridge for llama.cpp on Android.
 *
 * The real bridge requires:
 *   1. llama.cpp sources under `android/src/main/cpp/`
 *   2. A `CMakeLists.txt` pointing at them with GGML + NEON + OpenBLAS enabled
 *   3. A JNI wrapper (e.g. `android/src/main/cpp/jni_bridge.cpp`) exposing
 *      `loadModel`, `generate`, `unloadModel` as `extern "C"` functions
 *   4. `System.loadLibrary("llama_jni")` in this class's companion `init`
 *
 * None of those exist yet — see README.md. Until then, every method returns
 * an "unavailable" error so the JS layer falls back to the server-side engine.
 */
@CapacitorPlugin(name = "Llama")
class LlamaPlugin : Plugin() {

    private val inferenceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val inferenceMutex = Mutex()

    @Volatile
    private var loadedModelPath: String? = null

    @Volatile
    private var cancelRequested = false

    // ── Hardware probe ──────────────────────────────────────────────────

    @PluginMethod
    fun getHardwareInfo(call: PluginCall) {
        val context = context ?: run {
            call.reject("No context available")
            return
        }
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)

        val totalRamGb = memInfo.totalMem / 1_073_741_824.0
        val availableRamGb = memInfo.availMem / 1_073_741_824.0
        val cpuCores = Runtime.getRuntime().availableProcessors()

        val result = JSObject().apply {
            put("platform", "android")
            put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("totalRamGb", totalRamGb)
            put("availableRamGb", availableRamGb)
            put("cpuCores", cpuCores)
            put("gpuSupported", NATIVE_BACKEND_AVAILABLE)
            val gpu = JSObject().apply {
                put("backend", "vulkan")
                put("available", NATIVE_BACKEND_AVAILABLE)
            }
            put("gpu", if (NATIVE_BACKEND_AVAILABLE) gpu else JSObject.NULL)
        }
        call.resolve(result)
    }

    // ── Load / unload ───────────────────────────────────────────────────

    @PluginMethod
    fun isLoaded(call: PluginCall) {
        val result = JSObject().apply {
            put("loaded", loadedModelPath != null)
            put("modelPath", loadedModelPath ?: JSObject.NULL)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun loadModel(call: PluginCall) {
        if (!NATIVE_BACKEND_AVAILABLE) {
            call.reject(UNAVAILABLE_MESSAGE)
            return
        }
        val modelPath = call.getString("modelPath")
        if (modelPath.isNullOrEmpty()) {
            call.reject("modelPath is required")
            return
        }
        val contextSize = call.getInt("contextSize") ?: 4096
        val useGpu = call.getBoolean("useGpu") ?: true

        inferenceScope.launch {
            inferenceMutex.withLock {
                // TODO(llama.cpp): replace with real JNI loader:
                //   1. System.loadLibrary("llama_jni") once in a companion init
                //   2. nativeLoadModel(modelPath, contextSize, useGpu)
                //   3. throw a descriptive exception on failure
                loadedModelPath = modelPath
                call.resolve()
                // Silence unused-variable warnings until the JNI path lands.
                @Suppress("UNUSED_EXPRESSION") contextSize
                @Suppress("UNUSED_EXPRESSION") useGpu
            }
        }
    }

    @PluginMethod
    fun unloadModel(call: PluginCall) {
        inferenceScope.launch {
            inferenceMutex.withLock {
                // TODO(llama.cpp): nativeUnloadModel()
                loadedModelPath = null
                call.resolve()
            }
        }
    }

    // ── Generate ────────────────────────────────────────────────────────

    @PluginMethod
    fun generate(call: PluginCall) {
        if (!NATIVE_BACKEND_AVAILABLE) {
            call.reject(UNAVAILABLE_MESSAGE)
            return
        }
        if (loadedModelPath == null) {
            call.reject("No model loaded. Call loadModel first.")
            return
        }
        val prompt = call.getString("prompt") ?: run {
            call.reject("prompt is required")
            return
        }
        val maxTokens = call.getInt("maxTokens") ?: 512
        val temperature = call.getFloat("temperature") ?: 0.7f
        val topP = call.getFloat("topP") ?: 0.9f
        val stream = call.getBoolean("stream") ?: false

        cancelRequested = false
        val startedAt = System.currentTimeMillis()

        inferenceScope.launch {
            inferenceMutex.withLock {
                // TODO(llama.cpp): real JNI sampling loop.
                //   - tokenise prompt
                //   - decode step by step
                //   - respect cancelRequested / stopSequences
                //   - when `stream`, call notifyListeners("token", {...})
                val placeholder = "[llama.cpp native build not yet linked]"

                val duration = System.currentTimeMillis() - startedAt
                val result = JSObject().apply {
                    put("text", if (stream) "" else placeholder)
                    put("promptTokens", prompt.length / 4)
                    put("outputTokens", placeholder.length / 4)
                    put("durationMs", duration)
                }
                if (stream) {
                    notifyListeners("generationComplete", result)
                }
                call.resolve(result)

                @Suppress("UNUSED_EXPRESSION") maxTokens
                @Suppress("UNUSED_EXPRESSION") temperature
                @Suppress("UNUSED_EXPRESSION") topP
            }
        }
    }

    @PluginMethod
    fun cancelGenerate(call: PluginCall) {
        cancelRequested = true
        inferenceScope.coroutineContext[Job]?.cancelChildren()
        call.resolve()
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        inferenceScope.coroutineContext[Job]?.cancelChildren()
    }

    companion object {
        /**
         * Flips to true once the JNI wrapper is compiled and System.loadLibrary
         * succeeds. See README for build instructions.
         */
        private const val NATIVE_BACKEND_AVAILABLE = false
        private const val UNAVAILABLE_MESSAGE =
            "llama.cpp JNI bridge is not compiled into this build. See @elizaos/capacitor-llama/README.md for build instructions."
    }
}
