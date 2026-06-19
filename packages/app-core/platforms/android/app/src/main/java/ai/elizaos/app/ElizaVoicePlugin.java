package ai.elizaos.app;

import android.content.Context;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Phase 3a Capacitor plugin that drives the fused-voice JNI self-test from the
 * WebView/JS.
 *
 * <p>It proves the NDK/bionic {@code libelizainference.so} (the fork omnivoice
 * {@code elizainference} target — VAD/wake-word/speaker/diarizer fused at ABI
 * v7) loaded INSIDE the {@code ai.elizaos.app} process (bionic, NOT the musl
 * bun agent) and that a real voice op ({@code eliza_inference_*}) is callable
 * in-process.
 *
 * <p>JS surface:
 * <pre>
 *   Capacitor.Plugins.ElizaVoice.voiceAbiVersion()  // -> { loaded, abi: "7", supported }
 *   Capacitor.Plugins.ElizaVoice.vadSelfTest({ bundleDir })  // -> VAD self-test JSON
 * </pre>
 */
@CapacitorPlugin(name = "ElizaVoice")
public class ElizaVoicePlugin extends Plugin {

    private static final String TAG = "ElizaVoicePlugin";

    @PluginMethod
    public void voiceAbiVersion(PluginCall call) {
        if (!ElizaVoiceNative.ensureLoaded()) {
            JSObject result = new JSObject();
            result.put("loaded", false);
            result.put("error", String.valueOf(ElizaVoiceNative.getLoadError()));
            call.resolve(result);
            return;
        }
        try {
            String abi = ElizaVoiceNative.nativeVoiceAbiVersion();
            int supported = ElizaVoiceNative.nativeVadSupported();
            Log.i(TAG, "voiceAbiVersion abi=" + abi + " vadSupported=" + supported);
            JSObject result = new JSObject();
            result.put("loaded", true);
            result.put("abi", abi);
            result.put("supported", supported);
            call.resolve(result);
        } catch (UnsatisfiedLinkError e) {
            call.reject("Native voice ABI call failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void vadSelfTest(PluginCall call) {
        if (!ElizaVoiceNative.ensureLoaded()) {
            JSObject result = new JSObject();
            result.put("loaded", false);
            result.put("error", String.valueOf(ElizaVoiceNative.getLoadError()));
            call.resolve(result);
            return;
        }
        // Default bundle dir: <app files>/eliza-1/bundle. JS may override with
        // { bundleDir } to point at a staged Silero GGUF (vad/silero-vad-v5.gguf).
        String bundleDir = call.getString("bundleDir");
        if (bundleDir == null || bundleDir.isEmpty()) {
            Context context = getContext();
            File def = new File(context.getFilesDir(), "eliza-1/bundle");
            bundleDir = def.getAbsolutePath();
        }
        try {
            String json = ElizaVoiceNative.nativeVadSelfTest(bundleDir);
            Log.i(TAG, "vadSelfTest(" + bundleDir + ") -> " + json);
            JSObject result = new JSObject();
            result.put("loaded", true);
            result.put("bundleDir", bundleDir);
            result.put("result", json);
            call.resolve(result);
        } catch (UnsatisfiedLinkError e) {
            call.reject("Native VAD self-test failed: " + e.getMessage());
        }
    }
}
