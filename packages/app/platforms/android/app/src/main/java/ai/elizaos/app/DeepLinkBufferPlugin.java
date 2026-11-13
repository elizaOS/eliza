/**
 * Persists the latest Android ACTION_VIEW URL across WebView document
 * replacement and exposes a peek-and-ack Capacitor bridge. MainActivity
 * captures intents before Capacitor dispatches them. Each capture has a receipt
 * that both replay and warm delivery carry through application and acknowledgement.
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
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;
import java.util.UUID;

@CapacitorPlugin(name = "DeepLinkBuffer")
public final class DeepLinkBufferPlugin extends Plugin {

    private static final String TAG = "ElizaDeepLinkBuffer";
    private static final String PREFS_NAME = "eliza_deep_link_buffer";
    private static final String KEY_PENDING_URL = "pending_url";
    private static final String KEY_PENDING_RECEIPT = "pending_receipt";
    private static final String EXTRA_RECEIPT = "ai.elizaos.app.DEEP_LINK_RECEIPT";
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
            String receipt = UUID.randomUUID().toString();
            boolean committed = preferences(context)
                .edit()
                .putString(KEY_PENDING_URL, url)
                .putString(KEY_PENDING_RECEIPT, receipt)
                .commit();
            // MainActivity captures before dispatching this exact Intent. The
            // warm callback must carry its own identity even if a newer capture
            // has already replaced the preference slot.
            intent.putExtra(EXTRA_RECEIPT, receipt);
            if (!committed) {
                Log.e(TAG, "Failed to persist pending deep link");
            }
        }
    }

    @PluginMethod
    public void peekPendingUrl(PluginCall call) {
        String pending;
        String receipt;
        synchronized (LOCK) {
            SharedPreferences prefs = preferences(getContext());
            pending = prefs.getString(KEY_PENDING_URL, null);
            receipt = prefs.getString(KEY_PENDING_RECEIPT, null);
            if (pending != null && receipt == null) {
                // A URL retained by an older shell gets a stable receipt before
                // the new renderer can acknowledge it.
                receipt = UUID.randomUUID().toString();
                if (!prefs.edit().putString(KEY_PENDING_RECEIPT, receipt).commit()) {
                    // commit has already updated the visible preference map.
                    // Return that same identity even when disk confirmation is
                    // unavailable, so the next peek joins this application.
                    Log.e(TAG, "Failed to persist legacy deep-link receipt");
                }
            }
        }
        JSObject result = new JSObject();
        PluginHandle app = getBridge().getPlugin("App");
        boolean receiptEvents = app != null && app.getInstance() instanceof ReceiptAppPlugin;
        result.put("receiptVersion", receiptEvents ? 2 : 1);
        result.put("url", pending == null ? JSONObject.NULL : pending);
        result.put("receiptId", receipt == null ? JSONObject.NULL : receipt);
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledgePendingUrl(PluginCall call) {
        String acknowledged = call.getString("url");
        String receipt = call.getString("receiptId");
        if (acknowledged == null || acknowledged.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        boolean cleared = false;
        synchronized (LOCK) {
            SharedPreferences prefs = preferences(getContext());
            String pending = prefs.getString(KEY_PENDING_URL, null);
            String pendingReceipt = prefs.getString(KEY_PENDING_RECEIPT, null);
            if (receipt != null && receipt.equals(pendingReceipt) && acknowledged.equals(pending)) {
                cleared = prefs.edit()
                    .remove(KEY_PENDING_URL)
                    .remove(KEY_PENDING_RECEIPT)
                    .commit();
                if (!cleared) {
                    Log.e(TAG, "Failed to acknowledge pending deep link");
                }
            }
        }
        JSObject result = new JSObject();
        result.put("cleared", cleared);
        call.resolve(result);
    }

    static String capturedReceipt(Intent intent) {
        return intent == null ? null : intent.getStringExtra(EXTRA_RECEIPT);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
