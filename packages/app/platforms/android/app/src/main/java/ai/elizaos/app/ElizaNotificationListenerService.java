package ai.elizaos.app;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

public class ElizaNotificationListenerService extends NotificationListenerService {

    private static final String TAG = "ElizaNotifications";
    private static volatile ElizaNotificationListenerService instance;

    public static boolean isRunning() {
        return instance != null;
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        instance = this;
        Log.i(TAG, "Notification listener connected.");
    }

    @Override
    public void onListenerDisconnected() {
        instance = null;
        Log.i(TAG, "Notification listener disconnected.");
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) {
            return;
        }
        Log.d(TAG, "Notification posted: " + sbn.getPackageName());
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (sbn == null) {
            return;
        }
        Log.d(TAG, "Notification removed: " + sbn.getPackageName());
    }
}
