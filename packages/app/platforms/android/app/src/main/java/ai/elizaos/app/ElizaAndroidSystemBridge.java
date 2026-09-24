package ai.elizaos.app;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.util.Locale;
import java.util.UUID;

/**
 * App-side WebView binding for the privileged Android system bridge.
 *
 * The actual privileged state/control surface lives in
 * ai.elizaos.system.bridge. Until a booted image proves that service is bound,
 * this adapter exposes a fail-closed native object so the renderer can detect
 * the missing transport without falling back to mock state.
 */
public final class ElizaAndroidSystemBridge {

    public static final String JS_NAME = "ElizaAndroidSystemBridgeNative";

    private final Context appContext;

    private ElizaAndroidSystemBridge(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public static void install(WebView webView, Context context) {
        webView.addJavascriptInterface(new ElizaAndroidSystemBridge(context), JS_NAME);
        webView.evaluateJavascript(
            "window.__elizaAndroidBridge = window.__elizaAndroidBridge || null;",
            null
        );
    }

    @JavascriptInterface
    public String subscribe(String channel) {
        return String.format(
            Locale.US,
            "android-system-bridge-unbound:%s:%s",
            sanitizeChannel(channel),
            UUID.randomUUID()
        );
    }

    @JavascriptInterface
    public void unsubscribe(String id) {
        // No-op until the privileged bridge service is bound in a booted image.
    }

    @JavascriptInterface
    public String snapshot(String channel) {
        return unavailable(channel);
    }

    @JavascriptInterface
    public String send(String channel, String payloadJson) {
        return unavailable(channel);
    }

    private String unavailable(String channel) {
        return "{"
            + "\"available\":false,"
            + "\"channel\":\"" + jsonEscape(sanitizeChannel(channel)) + "\","
            + "\"package\":\"" + jsonEscape(appContext.getPackageName()) + "\","
            + "\"error\":\"privileged_android_system_bridge_not_bound\""
            + "}";
    }

    private static String sanitizeChannel(String channel) {
        if (channel == null) return "unknown";
        String trimmed = channel.trim();
        return trimmed.isEmpty() ? "unknown" : trimmed;
    }

    private static String jsonEscape(String value) {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }
}
