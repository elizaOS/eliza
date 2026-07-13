/**
 * Android half of the {@code NativeComposer} Capacitor plugin: renders the chat
 * INPUT as a real {@code EditText} added ABOVE the WebView at a webview-anchored
 * rect, used only in the maximized chat (the gate lives in ChatOverlay). iOS
 * half: {@code packages/app-core/platforms/ios/.../NativeComposer/NativeComposerPlugin.swift};
 * TS half: {@code packages/ui/src/glass/native-composer-bridge.ts}; shared
 * lifecycle: {@code packages/ui/src/glass/native-surface.ts}.
 *
 * <p>Layering mirrors NativeTranscript: appended last to the Capacitor container
 * so it sits above the WebView and owns touch/IME for its rect; the DOM textarea
 * underneath is hidden but keeps layout. Rects arrive viewport-relative in CSS px
 * and are scaled by display density + offset by the WebView origin, exactly like
 * GlassBridge/NativeTranscript.
 *
 * <p>Native owns the buffer + IME; it forwards only high-level INTENTS on the
 * single {@code composerEvent} listener (change/submit/focus/blur) — the send/
 * slash/paste BRAINS stay in JS. {@code setProps({draft})} is the JS→native
 * mirror for prefill; a draft equal to {@code lastPushedText} is skipped and the
 * watcher is suppressed during the programmatic set so the cursor never jumps and
 * no echo change is emitted.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.RectF;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebView;
import android.widget.EditText;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeComposer")
public class NativeComposerPlugin extends Plugin {

    private static final double MAX_RECT_COORD_CSS_PX = 100_000d;

    private String regionId;
    private EditText editText;
    /** Last text WE pushed/read; setProps skips a draft equal to it (echo guard). */
    private String lastPushedText = "";
    /** True while we set the text programmatically, to mute the change event. */
    private boolean suppressWatcher = false;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put(
                "available",
                getActivity() != null && bridge.getWebView() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void attach(PluginCall call) {
        String id = call.getString("id");
        RectF rect = parseRect(call.getObject("rect"));
        if (id == null || rect == null) {
            call.reject("attach requires id + a finite, positive rect");
            return;
        }
        String draft = call.getString("draft", "");
        String placeholder = call.getString("placeholder", "");
        boolean disabled = Boolean.TRUE.equals(call.getBoolean("disabled", false));
        Activity activity = getActivity();
        if (activity == null) {
            resolveAttached(call, false);
            return;
        }
        activity.runOnUiThread(() -> {
            WebView webView = bridge.getWebView();
            ViewGroup container =
                    webView != null ? (ViewGroup) webView.getParent() : null;
            if (webView == null || container == null) {
                resolveAttached(call, false);
                return;
            }
            teardown();

            EditText field = new EditText(activity);
            field.setBackgroundColor(Color.TRANSPARENT);
            field.setTextColor(Color.WHITE);
            field.setHintTextColor(Color.argb(128, 255, 255, 255));
            field.setHint(placeholder);
            field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
            field.setGravity(Gravity.TOP | Gravity.START);
            field.setPadding(4, 8, 4, 8);
            field.setEnabled(!disabled);
            // Return sends (chat idiom), like the iOS Return key; multi-line is a
            // later stage (needs a soft-keyboard modifier the action key lacks).
            field.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                    | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            field.setImeOptions(EditorInfo.IME_ACTION_SEND
                    | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
            field.setText(draft);

            field.addTextChangedListener(new TextWatcher() {
                @Override
                public void beforeTextChanged(
                        CharSequence s, int start, int count, int after) {}

                @Override
                public void onTextChanged(
                        CharSequence s, int start, int before, int count) {}

                @Override
                public void afterTextChanged(Editable s) {
                    if (suppressWatcher) return;
                    String text = s.toString();
                    lastPushedText = text;
                    emit("change", text);
                }
            });
            field.setOnEditorActionListener((view, actionId, event) -> {
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    emit("submit", null);
                    return true;
                }
                return false;
            });
            field.setOnFocusChangeListener(
                    (view, hasFocus) -> emit(hasFocus ? "focus" : "blur", null));

            container.addView(field);
            positionField(field, rect, webView);

            regionId = id;
            editText = field;
            lastPushedText = draft;
            resolveAttached(call, true);
        });
    }

    @PluginMethod
    public void updateRect(PluginCall call) {
        RectF rect = parseRect(call.getObject("rect"));
        Activity activity = getActivity();
        if (rect == null || activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            WebView webView = bridge.getWebView();
            if (editText == null || webView == null) {
                call.resolve();
                return;
            }
            positionField(editText, rect, webView);
            call.resolve();
        });
    }

    @PluginMethod
    public void setProps(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        String draft = call.getString("draft");
        String placeholder = call.getString("placeholder");
        Boolean disabled = call.getBoolean("disabled");
        activity.runOnUiThread(() -> {
            if (editText == null) {
                call.resolve();
                return;
            }
            if (draft != null
                    && !draft.equals(lastPushedText)
                    && !draft.equals(editText.getText().toString())) {
                suppressWatcher = true;
                editText.setText(draft);
                editText.setSelection(draft.length());
                suppressWatcher = false;
                lastPushedText = draft;
            }
            if (placeholder != null) editText.setHint(placeholder);
            if (disabled != null) editText.setEnabled(!disabled);
            call.resolve();
        });
    }

    @PluginMethod
    public void detach(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            teardown();
            call.resolve();
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private void positionField(EditText field, RectF rect, WebView webView) {
        float density = webView.getResources().getDisplayMetrics().density;
        ViewGroup.LayoutParams params = field.getLayoutParams();
        if (params == null) {
            params = new ViewGroup.LayoutParams(0, 0);
        }
        params.width = Math.round(rect.width() * density);
        params.height = Math.round(rect.height() * density);
        field.setLayoutParams(params);
        field.setX(rect.left * density + webView.getX());
        field.setY(rect.top * density + webView.getY());
    }

    private void teardown() {
        if (editText != null && editText.getParent() instanceof ViewGroup) {
            ((ViewGroup) editText.getParent()).removeView(editText);
        }
        editText = null;
        regionId = null;
    }

    private void emit(String kind, String value) {
        if (regionId == null) return;
        JSObject payload = new JSObject();
        payload.put("id", regionId);
        payload.put("kind", kind);
        if (value != null) payload.put("value", value);
        notifyListeners("composerEvent", payload);
    }

    private void resolveAttached(PluginCall call, boolean attached) {
        JSObject result = new JSObject();
        result.put("attached", attached);
        call.resolve(result);
    }

    // error-policy:J3 untrusted Capacitor boundary — a malformed rect produces
    // null → resolve as a no-op; nothing is clamped into a fake-valid rect.
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
