// spec/os/android/notificationProjection.md, "An occurrence alert leaves the updates channel only while the owner left that channel as the host made it"
package ai.eliza.plugins.notifications;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

/** Channel policy for the alerts the native inbox posts. */
public final class NativeNotificationChannels {
    private NativeNotificationChannels() {}
    /**
     * Channel group IDs that the host itself assigns to eliza_updates. By default (empty) any group
     * on eliza_updates counts as a customisation, and occurrence alerts stay on eliza_updates. A host
     * that groups its channels names those groups here before it posts, so that its own grouping does
     * not move occurrence alerts. Importance, sound and lock-screen choices still count, and so does
     * the owner blocking a host-assigned group: the alert then stays on the blocked eliza_updates
     * instead of escaping to a channel outside that group.
     */
    private static volatile java.util.Set<String> hostAssignedGroups = java.util.Set.of();
    public static void setHostAssignedGroups(java.util.Collection<String> groups) {
        hostAssignedGroups = java.util.Set.copyOf(groups);
    }
    /** The one channel an alert of this priority and owner type is posted on. */
    static NotificationChannel resolveReminderChannel(NotificationManager manager, String priority, String ownerType) {
        if ("high".equals(priority) && "occurrence".equals(ownerType)) {
            NotificationChannel previous = manager.getNotificationChannel("eliza_updates");
            if (previous != null && (
                Build.VERSION.SDK_INT < 30
                || previous.getImportance() != NotificationManager.IMPORTANCE_DEFAULT
                || (previous.getLockscreenVisibility() != android.app.Notification.VISIBILITY_PUBLIC
                    && previous.getLockscreenVisibility() != android.service.notification.NotificationListenerService.Ranking.VISIBILITY_NO_OVERRIDE)
                || (previous.getGroup() != null && (!hostAssignedGroups.contains(previous.getGroup())
                    || isReminderChannelBlocked(manager, previous)))
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
