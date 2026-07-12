/**
 * Android half of the {@code NativeTranscript} Capacitor plugin: mounts the
 * native transcript list ({@link TranscriptView}) over the WebView at a
 * viewport-relative CSS-pixel rect and streams widget action strings back to
 * JS on the single {@code transcriptAction} event. TS half:
 * {@code packages/ui/src/glass/native-transcript-bridge.ts}; frame contract:
 * {@code packages/ui/src/chat/native-transcript/spec.ts}.
 *
 * <p>Conventions mirror {@link ai.elizaos.app.GlassBridgePlugin}: rects
 * arrive in CSS px and are converted with the WebView's display density,
 * positioning is translation-based (parent-agnostic), rect parsing is a J3
 * untrusted boundary that rejects rather than clamps, and all view work runs
 * on the main thread. Unlike glass panels (inserted BELOW the WebView so the
 * page shows the material through transparent regions), the transcript list
 * is added ABOVE the WebView — it owns touch input for its rect; the DOM
 * keeps that region visually empty and the list's own background stays
 * transparent so the native backdrop reads through both layers.
 *
 * <p>{@code setTranscript} is a full-frame replace; {@link TranscriptView}
 * diffs rows by message id. A frame that arrives before {@code show} is kept
 * and rendered on mount, so callers may order the two calls freely.
 */
package ai.elizaos.app.transcript;

import android.app.Activity;
import android.graphics.RectF;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeTranscript")
public class NativeTranscriptPlugin extends Plugin {

    /** Untrusted-boundary rect envelope, identical to GlassBridgePlugin. */
    private static final double MAX_RECT_COORD_CSS_PX = 100_000d;

    /** Mounted list view. Main-thread only. */
    private TranscriptView transcriptView;
    /** Latest decoded frame; survives a setTranscript-before-show ordering. */
    private TranscriptModels.Frame pendingFrame;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        // The renderer is plain framework Views — available on every API
        // level this app ships to, as long as a WebView host exists.
        JSObject result = new JSObject();
        result.put("available",
                getActivity() != null && bridge.getWebView() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void setTranscript(PluginCall call) {
        JSObject rawFrame = call.getObject("frame");
        if (rawFrame == null) {
            call.reject("setTranscript requires frame");
            return;
        }
        // Decode off the UI thread (plugin executor); apply on it.
        TranscriptModels.Frame frame = TranscriptModels.decodeFrame(rawFrame);
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            pendingFrame = frame;
            if (transcriptView != null) {
                transcriptView.render(frame);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        RectF rect = parseRect(call.getObject("rect"));
        if (rect == null) {
            call.reject("show requires a finite, positive"
                    + " rect{x,y,width,height}");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        activity.runOnUiThread(() -> {
            WebView webView = bridge.getWebView();
            ViewGroup container =
                    webView != null ? (ViewGroup) webView.getParent() : null;
            if (webView == null || container == null) {
                call.reject("no webview container");
                return;
            }
            if (transcriptView == null) {
                transcriptView = new TranscriptView(activity,
                        new TranscriptWidgets.ActionSink() {
                            @Override
                            public void send(String message) {
                                emitAction(message);
                            }

                            @Override
                            public void sendEnvelope(
                                    java.util.Map<String, String> envelope) {
                                emitEnvelope(envelope);
                            }
                        });
                // Appended last = above the WebView: the list owns touch for
                // its rect (glass panels sit below; this must sit on top).
                container.addView(transcriptView);
                if (pendingFrame != null) {
                    transcriptView.render(pendingFrame);
                }
            }
            float density =
                    webView.getResources().getDisplayMetrics().density;
            ViewGroup.LayoutParams params = transcriptView.getLayoutParams();
            params.width = Math.round(rect.width() * density);
            params.height = Math.round(rect.height() * density);
            transcriptView.setLayoutParams(params);
            transcriptView.setX(rect.left * density + webView.getX());
            transcriptView.setY(rect.top * density + webView.getY());
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            removeTranscriptView();
            call.resolve();
        });
    }

    /** kind "message" — the DOM sendActionMessage strings. */
    private void emitAction(String message) {
        JSObject payload = new JSObject();
        payload.put("kind", "message");
        payload.put("message", message);
        notifyListeners("transcriptAction", payload);
    }

    /** Typed local intents (navigate/prefill/background — spec.ts). */
    private void emitEnvelope(java.util.Map<String, String> envelope) {
        JSObject payload = new JSObject();
        for (java.util.Map.Entry<String, String> entry : envelope.entrySet()) {
            payload.put(entry.getKey(), entry.getValue());
        }
        notifyListeners("transcriptAction", payload);
    }

    /** Main-thread only. */
    private void removeTranscriptView() {
        if (transcriptView != null
                && transcriptView.getParent() instanceof ViewGroup) {
            ((ViewGroup) transcriptView.getParent())
                    .removeView(transcriptView);
        }
        transcriptView = null;
    }

    @Override
    protected void handleOnDestroy() {
        removeTranscriptView();
        pendingFrame = null;
        super.handleOnDestroy();
    }

    // error-policy:J3 untrusted Capacitor boundary — a malformed rect
    // (missing/non-finite/non-positive/out-of-envelope values) produces an
    // explicit null → the method rejects; nothing is clamped into a
    // fake-valid region (GlassBridgePlugin.parseRect parity).
    private static RectF parseRect(JSObject object) {
        if (object == null) return null;
        double x = object.optDouble("x", Double.NaN);
        double y = object.optDouble("y", Double.NaN);
        double width = object.optDouble("width", Double.NaN);
        double height = object.optDouble("height", Double.NaN);
        if (!Double.isFinite(x) || !Double.isFinite(y)
                || !Double.isFinite(width) || !Double.isFinite(height)) {
            return null;
        }
        if (width <= 0 || height <= 0) return null;
        if (Math.abs(x) > MAX_RECT_COORD_CSS_PX
                || Math.abs(y) > MAX_RECT_COORD_CSS_PX
                || width > MAX_RECT_COORD_CSS_PX
                || height > MAX_RECT_COORD_CSS_PX) {
            return null;
        }
        return new RectF((float) x, (float) y,
                (float) (x + width), (float) (y + height));
    }
}
