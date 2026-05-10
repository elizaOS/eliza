package ai.elizaos.app;

import android.webkit.JavascriptInterface;

/**
 * Synchronous JS↔Java bridge that bypasses the Capacitor plugin layer.
 *
 * Capacitor's `Bridge.callPluginMethod` posts plugin invocations onto a
 * Handler tied to a worker thread. On long-lived sessions that worker
 * thread can be torn down (observed during foreground-service lifecycle
 * transitions on AOSP/Cuttlefish), leaving the Bridge holding a stale
 * Handler reference. Subsequent calls log
 * `IllegalStateException: sending message to a Handler on a dead thread`
 * and the JS Promise never resolves — the WebView's auth-status fetch
 * therefore never gets a bearer, and the React shell falls into the
 * pairing UI even though the in-app agent owns the bearer.
 *
 * The token is a simple volatile-string read in `ElizaAgentService`. A
 * standard `@JavascriptInterface` returns it synchronously without
 * touching Capacitor's queue, which makes the pair-code prompt
 * disappear on cold launch.
 *
 * Surface area is intentionally narrow — only the local agent bearer is
 * exposed, and only the same-origin WebView (which is the same APK uid
 * that owns the token file) can call it.
 */
public final class ElizaNativeBridge {

    public static final String JS_NAME = "ElizaNative";

    @JavascriptInterface
    public String getLocalAgentToken() {
        String token = ElizaAgentService.localAgentToken();
        if (token == null) return null;
        String trimmed = token.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
