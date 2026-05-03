package ai.elizaos.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.lang.reflect.Method;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "ElizaMainActivity";
    private static final int REQUEST_NOTIFICATION_PERMISSION = 1001;

    // Set by the AOSP product config (vendor/eliza/eliza_common.mk) on
    // every ElizaOS image; absent on stock Android. Reading it is the
    // signal that this APK is running as the system app on a Eliza
    // device, vs. installed on a vanilla phone where Eliza Cloud / Remote
    // / Local must remain user-selectable in the RuntimeGate picker.
    private static final String ELIZAOS_PRODUCT_PROP = "ro.elizaos.product";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The Capacitor WebView serves the renderer at https://localhost
        // (its default secure-context origin); the on-device Eliza agent
        // listens at http://127.0.0.1:31337. Without this knob the WebView
        // blocks every fetch to the loopback agent as a mixed-content
        // upgrade, surfacing in the UI as "Backend Timeout: /api/auth/status
        // - Failed to fetch" even though the agent is up. Granting
        // MIXED_CONTENT_ALWAYS_ALLOW only matters for loopback in this app
        // — the network_security_config still pins the WebView's allowed
        // cleartext hosts, and the Capacitor server.hostname locks the
        // page origin.
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            applyElizaOSUserAgentSuffix(settings);
        }

        // Android 13+ requires explicit POST_NOTIFICATIONS permission for the
        // foreground service notification to be visible.
        requestNotificationPermissionIfNeeded();

        // Start the foreground service so the OS keeps our process (and the
        // Capacitor WebSocket gateway plugin) alive in the background.
        GatewayConnectionService.start(this);

        // Start the local Eliza agent runtime as a foreground service so it
        // survives backgrounding and Doze. The boot receiver covers the
        // cold-boot path; this is the fast path when the user opens the app.
        ElizaAgentService.start(this);
    }

    @Override
    public void onDestroy() {
        // When the activity is fully destroyed (user swipe-kills the app),
        // tear down the foreground service to avoid an orphaned notification.
        // START_STICKY will restart the service if the system killed it, but
        // an explicit user-initiated destruction should respect the intent.
        if (isFinishing()) {
            GatewayConnectionService.stop(this);
        }
        super.onDestroy();
    }

    /**
     * Append `ElizaOS/<tag>` to the WebView's user-agent string when the
     * AOSP-set system property `ro.elizaos.product` is present. The web
     * layer (`platform/init.ts → isElizaOS()`) sniffs this suffix to
     * decide whether the RuntimeGate "Choose your setup" picker is
     * bypassed (ElizaOS) or rendered (vanilla Android APK).
     *
     * `android.os.SystemProperties` is hidden API but accessible via
     * reflection from the system app; on stock Android it returns "" and
     * we leave the user-agent untouched, preserving the picker.
     */
    private void applyElizaOSUserAgentSuffix(WebSettings settings) {
        String tag = readSystemProperty(ELIZAOS_PRODUCT_PROP);
        if (tag == null || tag.isEmpty()) {
            return;
        }
        String currentUa = settings.getUserAgentString();
        String marker = "ElizaOS/" + tag;
        if (currentUa != null && currentUa.contains(marker)) {
            return;
        }
        String newUa = (currentUa == null || currentUa.isEmpty())
            ? marker
            : currentUa + " " + marker;
        settings.setUserAgentString(newUa);
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            Method get = spClass.getMethod("get", String.class);
            Object result = get.invoke(null, key);
            return result instanceof String ? (String) result : "";
        } catch (ReflectiveOperationException | SecurityException e) {
            Log.w(TAG, "SystemProperties.get failed for " + key, e);
            return "";
        }
    }

    /**
     * On Android 13+ (API 33), POST_NOTIFICATIONS is a runtime permission.
     * Without it, the foreground service notification is silently suppressed.
     */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        int result = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS);
        if (result != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                new String[]{ Manifest.permission.POST_NOTIFICATIONS },
                REQUEST_NOTIFICATION_PERMISSION
            );
        }
    }
}
