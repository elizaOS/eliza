package ai.elizaos.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_NOTIFICATION_PERMISSION = 1001;

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
        MiladyAgentService.start(this);
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
