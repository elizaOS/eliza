package ai.milaidy.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the Android process alive so the Capacitor
 * gateway plugin can maintain its WebSocket connection while the app is in
 * the background.
 *
 * The service itself does NOT own the WebSocket — it only holds a persistent
 * notification and prevents the OS from killing the process. The actual
 * connection is managed by the Capacitor gateway plugin on the JS side.
 */
public class GatewayConnectionService extends Service {

    private static final String CHANNEL_ID = "gateway_connection";
    private static final int NOTIFICATION_ID = 1;

    // Intent actions
    private static final String ACTION_STOP = "ai.milaidy.app.action.STOP_GATEWAY";
    private static final String ACTION_UPDATE_STATUS = "ai.milaidy.app.action.UPDATE_STATUS";

    // Extras
    private static final String EXTRA_STATUS = "status";

    // Connection status constants — kept in sync with JS plugin events.
    public static final String STATUS_CONNECTED = "connected";
    public static final String STATUS_DISCONNECTED = "disconnected";
    public static final String STATUS_RECONNECTING = "reconnecting";

    private String currentStatus = STATUS_DISCONNECTED;

    // ── Lifecycle ────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();

        Notification notification = buildNotification("Milaidy Gateway", "Starting…");

        // API 34+ requires explicit foreground service type when calling startForeground().
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_STOP.equals(action)) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (ACTION_UPDATE_STATUS.equals(action)) {
                String status = intent.getStringExtra(EXTRA_STATUS);
                if (status != null) {
                    currentStatus = status;
                    updateNotification();
                }
                return START_STICKY;
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        // Clean up the notification when the service is torn down.
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.cancel(NOTIFICATION_ID);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        // Not a bound service.
        return null;
    }

    // ── Notification helpers ─────────────────────────────────────────────

    /**
     * Create the low-importance notification channel (Android 8+).
     * IMPORTANCE_LOW keeps the notification silent (no sound/vibration).
     */
    private void ensureNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Gateway Connection",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows Milaidy gateway connection status");
        channel.setShowBadge(false);

        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr != null) {
            mgr.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String title, String text) {
        // Tapping the notification opens the main activity.
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launchPending = PendingIntent.getActivity(
            this, 1, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // "Disconnect" action in the notification.
        Intent stopIntent = new Intent(this, GatewayConnectionService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(launchPending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Disconnect", stopPending)
            .build();
    }

    /** Push an updated notification to reflect the current connection status. */
    private void updateNotification() {
        String title;
        String text;

        switch (currentStatus) {
            case STATUS_CONNECTED:
                title = "Milaidy Gateway · Connected";
                text = "WebSocket connection active";
                break;
            case STATUS_RECONNECTING:
                title = "Milaidy Gateway · Reconnecting";
                text = "Attempting to restore connection…";
                break;
            default:
                title = "Milaidy Gateway";
                text = "Disconnected";
                break;
        }

        Notification notification = buildNotification(title, text);
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.notify(NOTIFICATION_ID, notification);
        }
    }

    // ── Static helpers for callers ───────────────────────────────────────

    /** Start the foreground service (safe to call repeatedly). */
    public static void start(Context context) {
        Intent intent = new Intent(context, GatewayConnectionService.class);
        context.startForegroundService(intent);
    }

    /** Request a graceful stop via the ACTION_STOP intent. */
    public static void stop(Context context) {
        Intent intent = new Intent(context, GatewayConnectionService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    /**
     * Update the notification to reflect a new connection status.
     *
     * @param context Android context
     * @param status  One of {@link #STATUS_CONNECTED}, {@link #STATUS_DISCONNECTED},
     *                or {@link #STATUS_RECONNECTING}.
     */
    public static void updateStatus(Context context, String status) {
        Intent intent = new Intent(context, GatewayConnectionService.class);
        intent.setAction(ACTION_UPDATE_STATUS);
        intent.putExtra(EXTRA_STATUS, status);
        context.startService(intent);
    }
}
