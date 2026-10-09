/**
 * Persists the latest Android ACTION_VIEW URL across WebView document
 * replacement and exposes a peek-and-ack Capacitor bridge. MainActivity
 * captures intents before Capacitor dispatches them so a renderer that has not
 * registered appUrlOpen yet can replay the URL without clearing it prematurely.
 */
package ai.elizaos.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "DeepLinkBuffer")
public final class DeepLinkBufferPlugin extends Plugin {

    private static final String TAG = "ElizaDeepLinkBuffer";
    private static final String PREFS_NAME = "eliza_deep_link_buffer";
    private static final String KEY_PENDING_URL = "pending_url";
    private static final Object LOCK = new Object();

    static void captureIntent(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri data = intent.getData();
        if (data == null) {
            return;
        }
        String url = data.toString().trim();
        if (url.isEmpty()) {
            return;
        }
        synchronized (LOCK) {
            boolean committed = preferences(context)
                .edit()
                .putString(KEY_PENDING_URL, url)
                .commit();
            if (!committed) {
                Log.e(TAG, "Failed to persist pending deep link");
            }
        }
    }

    @PluginMethod
    public void peekPendingUrl(PluginCall call) {
        String pending;
        synchronized (LOCK) {
            pending = preferences(getContext()).getString(KEY_PENDING_URL, null);
        }
        JSObject result = new JSObject();
        result.put("url", pending == null ? JSONObject.NULL : pending);
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledgePendingUrl(PluginCall call) {
        String acknowledged = call.getString("url");
        if (acknowledged == null || acknowledged.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        boolean cleared = false;
        synchronized (LOCK) {
            SharedPreferences prefs = preferences(getContext());
            String pending = prefs.getString(KEY_PENDING_URL, null);
            if (acknowledged.equals(pending)) {
                cleared = prefs.edit().remove(KEY_PENDING_URL).commit();
                if (!cleared) {
                    Log.e(TAG, "Failed to acknowledge pending deep link");
                }
            }
        }
        JSObject result = new JSObject();
        result.put("cleared", cleared);
        call.resolve(result);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
