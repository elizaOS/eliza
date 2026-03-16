package ai.milaidy.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_NOTIFICATION_PERMISSION = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Android 13+ requires explicit POST_NOTIFICATIONS permission for the
        // foreground service notification to be visible.
        requestNotificationPermissionIfNeeded();

        // Start the foreground service so the OS keeps our process (and the
        // Capacitor WebSocket gateway plugin) alive in the background.
        GatewayConnectionService.start(this);
    }

    @Override
    protected void onDestroy() {
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
