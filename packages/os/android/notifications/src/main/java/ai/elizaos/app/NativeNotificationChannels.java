package ai.elizaos.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

/** Shared channel policy for FCM and native canonical inbox delivery. */
final class NativeNotificationChannels {
    private NativeNotificationChannels() {}
    /** One channel authority for cold FCM and foreground LocalNotifications. */
    static NotificationChannel resolveReminderChannel(NotificationManager manager, String priority, String ownerType) {
        if ("high".equals(priority) && "occurrence".equals(ownerType)) {
            NotificationChannel previous = manager.getNotificationChannel("eliza_updates");
            if (previous != null && (
                Build.VERSION.SDK_INT < 30
                || previous.getImportance() != NotificationManager.IMPORTANCE_DEFAULT
                || (previous.getLockscreenVisibility() != android.app.Notification.VISIBILITY_PUBLIC
                    && previous.getLockscreenVisibility() != android.service.notification.NotificationListenerService.Ranking.VISIBILITY_NO_OVERRIDE)
                || previous.getGroup() != null
                || (Build.VERSION.SDK_INT >= 29 && previous.hasUserSetImportance())
                || (Build.VERSION.SDK_INT >= 30 && previous.hasUserSetSound())
            )) return previous;
        }
        String id;
        String name;
        int importance;
        if ("urgent".equals(priority)) {
            id = "eliza_alerts"; name = "Eliza alerts"; importance = NotificationManager.IMPORTANCE_HIGH;
        } else if ("high".equals(priority)) {
            id = "eliza_notifications"; name = "Eliza"; importance = NotificationManager.IMPORTANCE_HIGH;
        } else if ("normal".equals(priority)) {
            id = "eliza_updates"; name = "Eliza updates"; importance = NotificationManager.IMPORTANCE_DEFAULT;
        } else if ("low".equals(priority)) {
            id = "eliza_quiet"; name = "Eliza background"; importance = NotificationManager.IMPORTANCE_LOW;
        } else throw new IllegalArgumentException("Invalid reminder priority");
        NotificationChannel existing = manager.getNotificationChannel(id);
        return existing != null ? existing : new NotificationChannel(id, name, importance);
    }

    static boolean isReminderChannelBlocked(NotificationManager manager, NotificationChannel channel) {
        if (channel == null || channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return true;
        if (Build.VERSION.SDK_INT >= 28 && channel.getGroup() != null) {
            android.app.NotificationChannelGroup group = manager.getNotificationChannelGroup(channel.getGroup());
            return group != null && group.isBlocked();
        }
        return false;
    }

}
