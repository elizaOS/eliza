package ai.elizaos.app;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Capacitor plugin that drives the fused-voice JNI host from the WebView/JS.
 *
 * <p>This is the in-process bionic transport for the WHOLE voice pipeline (VAD,
 * wake-word, speaker, diarizer) — it replaces the musl bun-agent
 * {@code /api/voice/audio-frames} hop for the four voice classifiers. The JNI
 * host runs the VAD streaming hot-loop + turn segmentation natively and
 * surfaces turn-level results; the JS layer applies the ambient gate and builds
 * the voiceTurnSignal.
 *
 * <p>PCM marshalling uses base64 little-endian s16 (the same wire format the
 * Android {@code audioFrame} event uses) so a 1 s batch is ~32 KB of base64,
 * not a 16000-element JSON float array. Float outputs (the 256-d speaker
 * embedding) and int8 outputs (diariz frame labels) are returned base64-encoded
 * too.
 *
 * <p>JS surface (Capacitor.Plugins.ElizaVoice):
 * <pre>
 *   voiceAbiVersion()                          -> { loaded, abi, vad, wakeword, speaker, diariz }
 *   vadSelfTest({ bundleDir })                 -> { result }   (Phase 3a self-test)
 *   contextCreate({ bundleDir })               -> { handle }
 *   contextDestroy({ handle })
 *   pipelineOpen({ ctx })                      -> { handle }
 *   pipelineProcess({ handle, pcm16, includePcm? }) -> { turns: [{turnId,samples,...,embedding?,labels?,pcm?}] }
 *   pipelineFlush({ handle, includePcm? })     -> { turns: [...] }
 *   pipelineReset({ handle }) / pipelineClose({ handle })
 *   wakewordOpen({ ctx, headName })            -> { handle }
 *   wakewordScore({ handle, pcm16 })           -> { scores: number[] }
 *   wakewordReset / wakewordClose
 *   vadOpen / vadProcess / vadReset / vadClose
 *   speakerOpen / speakerEmbed / speakerClose
 *   diarizOpen / diarizSegment / diarizClose
 * </pre>
 */
@CapacitorPlugin(name = "ElizaVoice")
public class ElizaVoicePlugin extends Plugin {

    private static final String TAG = "ElizaVoicePlugin";

    private boolean ensureLoadedOrReject(PluginCall call) {
        if (ElizaVoiceNative.ensureLoaded()) {
            return true;
        }
        call.reject("Fused voice native libraries failed to load: "
            + ElizaVoiceNative.getLoadError());
        return false;
    }

    /** Decode base64 LE-s16 PCM into a Java float[] in [-1, 1]. */
    private static float[] decodePcm16(String b64) {
        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        int n = bytes.length / 2;
        ByteBuffer bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        float[] out = new float[n];
        for (int i = 0; i < n; i++) {
            out[i] = bb.getShort(i * 2) / 32768f;
        }
        return out;
    }

    /** Encode a float[] as base64 little-endian fp32. */
    private static String encodeFloats(float[] arr) {
        if (arr == null) return "";
        ByteBuffer bb = ByteBuffer.allocate(arr.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float v : arr) bb.putFloat(v);
        return Base64.encodeToString(bb.array(), Base64.NO_WRAP);
    }

    /** Encode a byte[] (int8 labels) as base64. */
    private static String encodeBytes(byte[] arr) {
        if (arr == null) return "";
        return Base64.encodeToString(arr, Base64.NO_WRAP);
    }

    // ── ABI / capability ────────────────────────────────────────────────

    @PluginMethod
    public void voiceAbiVersion(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            JSObject result = new JSObject();
            result.put("loaded", true);
            result.put("abi", ElizaVoiceNative.nativeVoiceAbiVersion());
            result.put("vad", ElizaVoiceNative.nativeVadSupported());
            result.put("wakeword", ElizaVoiceNative.nativeWakewordSupported());
            result.put("speaker", ElizaVoiceNative.nativeSpeakerSupported());
            result.put("diariz", ElizaVoiceNative.nativeDiarizSupported());
            Log.i(TAG, "voiceAbiVersion " + result.toString());
            call.resolve(result);
        } catch (Throwable e) {
            call.reject("voiceAbiVersion failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void vadSelfTest(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        String bundleDir = resolveBundleDir(call.getString("bundleDir"));
        try {
            String json = ElizaVoiceNative.nativeVadSelfTest(bundleDir);
            Log.i(TAG, "vadSelfTest(" + bundleDir + ") -> " + json);
            JSObject result = new JSObject();
            result.put("loaded", true);
            result.put("bundleDir", bundleDir);
            result.put("result", json);
            call.resolve(result);
        } catch (Throwable e) {
            call.reject("vadSelfTest failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void wakewordSelfTest(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        String bundleDir = resolveBundleDir(call.getString("bundleDir"));
        try {
            float[] pos = decodePcm16(call.getString("pos", ""));
            float[] neg = decodePcm16(call.getString("neg", ""));
            String json = ElizaVoiceNative.nativeWakewordSelfTest(bundleDir, pos, neg);
            Log.i(TAG, "wakewordSelfTest -> " + json);
            JSObject r = new JSObject();
            r.put("result", json);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("wakewordSelfTest failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pipelineSelfTest(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        String bundleDir = resolveBundleDir(call.getString("bundleDir"));
        Integer feed = call.getInt("feedSamples", 16000);
        try {
            float[] pcm = decodePcm16(call.getString("pcm16", ""));
            String json = ElizaVoiceNative.nativePipelineSelfTest(
                bundleDir, pcm, feed != null ? feed : 16000);
            Log.i(TAG, "pipelineSelfTest -> " + json);
            JSObject r = new JSObject();
            r.put("turns", json);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("pipelineSelfTest failed: " + e.getMessage());
        }
    }

    // ── Text generation (LLM) — GPU-accelerated path in the bionic app process ──

    /**
     * Capability probe for the text path. With the dynamic-Vulkan
     * libelizainference staged, llmStream is supported and runs on the Mali GPU
     * in THIS process (the musl bun agent can't reach libvulkan).
     */
    @PluginMethod
    public void llmAbiProbe(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            JSObject r = new JSObject();
            r.put("loaded", true);
            r.put("abi", ElizaVoiceNative.nativeVoiceAbiVersion());
            r.put("llmStream", ElizaVoiceNative.nativeLlmStreamSupported());
            r.put("embed", ElizaVoiceNative.nativeEmbedSupported());
            r.put("eot", ElizaVoiceNative.nativeEotSupported());
            Log.i(TAG, "llmAbiProbe " + r.toString());
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("llmAbiProbe failed: " + e.getMessage());
        }
    }

    /**
     * KEYSTONE proof: run a whole greedy generation in one native call, in the
     * bionic app process. ggml-vulkan logs the Mali device + layer offload to
     * logcat; the returned JSON carries {ok, text, tokens, ms, tokS}.
     */
    @PluginMethod
    public void llmSelfTest(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        String bundleDir = resolveBundleDir(call.getString("bundleDir"));
        String prompt = call.getString("prompt",
            "<start_of_turn>user\nWrite one sentence about the ocean.<end_of_turn>\n<start_of_turn>model\n");
        Integer maxTokens = call.getInt("maxTokens", 48);
        try {
            String json = ElizaVoiceNative.nativeLlmSelfTest(
                bundleDir, prompt, maxTokens != null ? maxTokens : 48);
            Log.i(TAG, "llmSelfTest(" + bundleDir + ") -> " + json);
            JSObject r = new JSObject();
            r.put("result", json);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("llmSelfTest failed: " + e.getMessage());
        }
    }

    private String resolveBundleDir(String requested) {
        if (requested != null && !requested.isEmpty()) return requested;
        Context context = getContext();
        File def = new File(context.getFilesDir(), "eliza-1/bundle");
        return def.getAbsolutePath();
    }

    // ── Context lifecycle ───────────────────────────────────────────────

    @PluginMethod
    public void contextCreate(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        String bundleDir = resolveBundleDir(call.getString("bundleDir"));
        try {
            long handle = ElizaVoiceNative.nativeContextCreate(bundleDir);
            JSObject r = new JSObject();
            r.put("handle", String.valueOf(handle));
            r.put("bundleDir", bundleDir);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("contextCreate failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void contextDestroy(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeContextDestroy(longArg(call, "handle"));
        call.resolve();
    }

    /** Capacitor numbers lose precision on raw pointers; pass them as strings. */
    private static long longArg(PluginCall call, String key) {
        String s = call.getString(key);
        if (s != null) {
            try { return Long.parseLong(s); } catch (NumberFormatException ignored) {}
        }
        Double d = call.getDouble(key);
        return d != null ? d.longValue() : 0L;
    }

    // ── Streaming pipeline ──────────────────────────────────────────────

    @PluginMethod
    public void pipelineOpen(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            long handle = ElizaVoiceNative.nativePipelineOpen(longArg(call, "ctx"));
            JSObject r = new JSObject();
            r.put("handle", String.valueOf(handle));
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("pipelineOpen failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pipelineProcess(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        long handle = longArg(call, "handle");
        String pcm16 = call.getString("pcm16", "");
        boolean includePcm = Boolean.TRUE.equals(call.getBoolean("includePcm", false));
        try {
            float[] pcm = decodePcm16(pcm16);
            String turnsJson = ElizaVoiceNative.nativePipelineProcess(handle, pcm);
            call.resolve(buildTurns(handle, turnsJson, includePcm));
        } catch (Throwable e) {
            call.reject("pipelineProcess failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pipelineFlush(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        long handle = longArg(call, "handle");
        boolean includePcm = Boolean.TRUE.equals(call.getBoolean("includePcm", false));
        try {
            String turnsJson = ElizaVoiceNative.nativePipelineFlush(handle);
            call.resolve(buildTurns(handle, turnsJson, includePcm));
        } catch (Throwable e) {
            call.reject("pipelineFlush failed: " + e.getMessage());
        }
    }

    /** Attach per-turn native payloads to the native turn JSON. */
    private JSObject buildTurns(long handle, String turnsJson, boolean includePcm) throws JSONException {
        JSONArray native_ = new JSONArray(turnsJson);
        JSArray turns = new JSArray();
        for (int i = 0; i < native_.length(); i++) {
            JSObject turn = JSObject.fromJSONObject(native_.getJSONObject(i));
            float[] emb = ElizaVoiceNative.nativePipelineTurnEmbedding(handle, i);
            byte[] labels = ElizaVoiceNative.nativePipelineTurnLabels(handle, i);
            turn.put("embedding", encodeFloats(emb));
            turn.put("embeddingDim", emb != null ? emb.length : 0);
            turn.put("labels", encodeBytes(labels));
            turn.put("labelCount", labels != null ? labels.length : 0);
            if (includePcm) {
                float[] pcm = ElizaVoiceNative.nativePipelineTurnPcm(handle, i);
                turn.put("pcm", encodeFloats(pcm));
                turn.put("pcmSampleRate", 16000);
            }
            turns.put(turn);
        }
        JSObject r = new JSObject();
        r.put("turns", turns);
        return r;
    }

    @PluginMethod
    public void pipelineReset(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativePipelineReset(longArg(call, "handle"));
        call.resolve();
    }

    @PluginMethod
    public void pipelineClose(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativePipelineClose(longArg(call, "handle"));
        call.resolve();
    }

    // ── VAD direct ──────────────────────────────────────────────────────

    @PluginMethod
    public void vadOpen(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            long h = ElizaVoiceNative.nativeVadOpen(longArg(call, "ctx"));
            JSObject r = new JSObject();
            r.put("handle", String.valueOf(h));
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("vadOpen failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void vadProcess(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            float[] probs = ElizaVoiceNative.nativeVadProcessBatch(
                longArg(call, "handle"), decodePcm16(call.getString("pcm16", "")));
            call.resolve(floatArrayResult("probabilities", probs));
        } catch (Throwable e) {
            call.reject("vadProcess failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void vadReset(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeVadReset(longArg(call, "handle"));
        call.resolve();
    }

    @PluginMethod
    public void vadClose(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeVadClose(longArg(call, "handle"));
        call.resolve();
    }

    // ── Wake-word ───────────────────────────────────────────────────────

    @PluginMethod
    public void wakewordOpen(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            long h = ElizaVoiceNative.nativeWakewordOpen(
                longArg(call, "ctx"), call.getString("headName", "hey-eliza"));
            JSObject r = new JSObject();
            r.put("handle", String.valueOf(h));
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("wakewordOpen failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void wakewordScore(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            float[] scores = ElizaVoiceNative.nativeWakewordScoreBatch(
                longArg(call, "handle"), decodePcm16(call.getString("pcm16", "")));
            call.resolve(floatArrayResult("scores", scores));
        } catch (Throwable e) {
            call.reject("wakewordScore failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void wakewordReset(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeWakewordReset(longArg(call, "handle"));
        call.resolve();
    }

    @PluginMethod
    public void wakewordClose(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeWakewordClose(longArg(call, "handle"));
        call.resolve();
    }

    // ── Speaker ─────────────────────────────────────────────────────────

    @PluginMethod
    public void speakerOpen(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            long h = ElizaVoiceNative.nativeSpeakerOpen(
                longArg(call, "ctx"), call.getString("ggufPath", ""));
            JSObject r = new JSObject();
            r.put("handle", String.valueOf(h));
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("speakerOpen failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void speakerEmbed(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            float[] emb = ElizaVoiceNative.nativeSpeakerEmbed(
                longArg(call, "handle"), decodePcm16(call.getString("pcm16", "")));
            JSObject r = new JSObject();
            r.put("embedding", encodeFloats(emb));
            r.put("embeddingDim", emb != null ? emb.length : 0);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("speakerEmbed failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void speakerClose(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeSpeakerClose(longArg(call, "handle"));
        call.resolve();
    }

    // ── Diarizer ────────────────────────────────────────────────────────

    @PluginMethod
    public void diarizOpen(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            long h = ElizaVoiceNative.nativeDiarizOpen(
                longArg(call, "ctx"), call.getString("ggufPath", ""));
            JSObject r = new JSObject();
            r.put("handle", String.valueOf(h));
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("diarizOpen failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void diarizSegment(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        try {
            byte[] labels = ElizaVoiceNative.nativeDiarizSegment(
                longArg(call, "handle"), decodePcm16(call.getString("pcm16", "")));
            JSObject r = new JSObject();
            r.put("labels", encodeBytes(labels));
            r.put("labelCount", labels != null ? labels.length : 0);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("diarizSegment failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void diarizClose(PluginCall call) {
        if (!ensureLoadedOrReject(call)) return;
        ElizaVoiceNative.nativeDiarizClose(longArg(call, "handle"));
        call.resolve();
    }

    private static JSObject floatArrayResult(String key, float[] arr) throws JSONException {
        JSArray out = new JSArray();
        if (arr != null) {
            for (float v : arr) out.put((double) v);
        }
        JSObject r = new JSObject();
        r.put(key, out);
        return r;
    }
}
