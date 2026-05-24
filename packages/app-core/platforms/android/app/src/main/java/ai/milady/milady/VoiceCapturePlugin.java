package ai.milady.milady;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin that starts/stops the {@link ElizaVoiceCaptureService}
 * microphone foreground service from JS.
 *
 * <p>The in-WebView voice pill captures via getUserMedia and dies when the
 * WebView is backgrounded. This plugin lets the renderer engage the native
 * always-on / VAD-gated capture path that survives backgrounding by holding
 * a microphone-typed FGS (R10 §6.2).
 *
 * <p>RECORD_AUDIO is a runtime permission. {@link #startBackgroundCapture}
 * rejects with {@code record_audio_denied} when it is not granted rather than
 * starting a mic FGS that the OS would immediately kill. JS should call
 * {@link #requestMicPermission} (user gesture) first, or rely on the WebView
 * getUserMedia grant the voice pill already triggers.
 */
@CapacitorPlugin(name = "VoiceCapture")
public class VoiceCapturePlugin extends Plugin {

    private static final int REQUEST_CODE_RECORD_AUDIO = 2001;

    @PluginMethod
    public void startBackgroundCapture(PluginCall call) {
        Context context = getContext();
        if (!hasRecordAudio(context)) {
            JSObject result = new JSObject();
            result.put("started", false);
            result.put("reason", "record_audio_denied");
            call.resolve(result);
            return;
        }
        String mode = call.getString("mode");
        try {
            ElizaVoiceCaptureService.start(context);
            if (mode != null && !mode.isEmpty()) {
                ElizaVoiceCaptureService.setMode(context, mode);
            }
            JSObject result = new JSObject();
            result.put("started", true);
            call.resolve(result);
        } catch (RuntimeException e) {
            call.reject("Failed to start voice capture service", e);
        }
    }

    @PluginMethod
    public void stopBackgroundCapture(PluginCall call) {
        try {
            ElizaVoiceCaptureService.stop(getContext());
            JSObject result = new JSObject();
            result.put("stopped", true);
            call.resolve(result);
        } catch (RuntimeException e) {
            call.reject("Failed to stop voice capture service", e);
        }
    }

    @PluginMethod
    public void setMode(PluginCall call) {
        String mode = call.getString("mode");
        if (mode == null || mode.isEmpty()) {
            call.reject("mode is required");
            return;
        }
        ElizaVoiceCaptureService.setMode(getContext(), mode);
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void isCaptureSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasRecordAudio(getContext()));
        call.resolve(result);
    }

    /**
     * Request RECORD_AUDIO via the host activity. Resolves immediately with
     * the pre-request state; the OS dialog result is observed on the next
     * {@link #isCaptureSupported} read. Must be invoked from a user gesture.
     */
    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        Context context = getContext();
        boolean granted = hasRecordAudio(context);
        if (!granted) {
            Activity activity = getActivity();
            if (activity != null) {
                activity.requestPermissions(
                    new String[] { Manifest.permission.RECORD_AUDIO },
                    REQUEST_CODE_RECORD_AUDIO
                );
            }
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private static boolean hasRecordAudio(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }
}
