package ai.elizaos.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.net.Uri;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;

/** Projects negotiated reminder data without a WebView. The server inbox stays authoritative. */
public final class ElizaReminderMessagingService extends MessagingService {
    private static final String TAG = "ElizaReminderPush";
    private static final String RECEIPTS = "eliza_reminder_push_receipts";
    private static final Object DELIVERY_LOCK = new Object();
    // FCM retains a message for at most four weeks. Receipts cover that entire
    // replay lifetime and are pruned on the next valid data delivery.
    private static final long RECEIPT_LIFETIME_MS = TimeUnit.DAYS.toMillis(28);
    private static final Pattern NOTIFICATION_ID = Pattern.compile(
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    );

    static boolean isDeclaredHandler(Context context) {
        ResolveInfo resolved = context.getPackageManager().resolveService(
            new Intent("com.google.firebase.MESSAGING_EVENT").setPackage(context.getPackageName()),
            0
        );
        return resolved != null && resolved.serviceInfo != null
            && resolved.serviceInfo.enabled
            && context.getPackageName().equals(resolved.serviceInfo.packageName)
            && ElizaReminderMessagingService.class.getName().equals(resolved.serviceInfo.name);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        if (message.getNotification() == null && "1".equals(message.getData().get("elizaReminderData"))) {
            projectReminder(message);
        }
        // Keep standard token/notification transport and the Capacitor data event.
        super.onMessageReceived(message);
    }

    private void projectReminder(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String id = data.get("notificationId");
        String title = data.get("title");
        String body = data.get("body");
        String priority = data.get("priority");
        if (!"reminder".equals(data.get("category")) || id == null
            || !NOTIFICATION_ID.matcher(id).matches() || title == null
            || title.trim().isEmpty() || title.length() > 512 || title.indexOf('\0') >= 0
            || body == null || body.length() > 4096 || body.indexOf('\0') >= 0) return;
        String channel;
        String channelName;
        int importance;
        if ("urgent".equals(priority)) {
            channel = "eliza_alerts"; channelName = "Eliza alerts"; importance = 5;
        } else if ("high".equals(priority)) {
            channel = "eliza_notifications"; channelName = "Eliza"; importance = 4;
        } else if ("normal".equals(priority)) {
            channel = "eliza_updates"; channelName = "Eliza updates"; importance = 3;
        } else if ("low".equals(priority)) {
            channel = "eliza_quiet"; channelName = "Eliza background"; importance = 2;
        } else return;
        id = id.toLowerCase(java.util.Locale.ROOT);
        synchronized (DELIVERY_LOCK) {
            SharedPreferences receipts = getSharedPreferences(RECEIPTS, MODE_PRIVATE);
            long now = System.currentTimeMillis();
            long cutoff = now - RECEIPT_LIFETIME_MS;
            SharedPreferences.Editor pruning = receipts.edit();
            boolean pruned = false;
            for (Map.Entry<String, ?> entry : receipts.getAll().entrySet()) {
                if (!(entry.getValue() instanceof Long) || ((Long) entry.getValue()) <= cutoff) {
                    pruning.remove(entry.getKey());
                    pruned = true;
                }
            }
            if (pruned && !pruning.commit()) Log.w(TAG, "Could not prune expired delivery receipts");
            Object recordedAt = receipts.getAll().get(id);
            if (recordedAt instanceof Long && ((Long) recordedAt) > cutoff) return;
            if ((Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                    this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                || !NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;
            if ("normal".equals(priority)) {
                NotificationChannel previous = manager.getNotificationChannel("eliza_updates");
                // Timed reminders alert by default; retain an existing user-selected
                // quiet/blocked tier rather than moving it to another channel.
                boolean customized = previous != null && (
                    previous.getImportance() != NotificationManager.IMPORTANCE_DEFAULT
                    || (Build.VERSION.SDK_INT >= 29 && previous.hasUserSetImportance())
                    || (Build.VERSION.SDK_INT >= 30 && previous.hasUserSetSound())
                );
                if (!customized) {
                    channel = "eliza_notifications";
                    channelName = "Eliza";
                    importance = NotificationManager.IMPORTANCE_HIGH;
                }
            }
            if (manager.getNotificationChannel(channel) == null) {
                NotificationChannel nativeChannel = new NotificationChannel(channel, channelName, importance);
                nativeChannel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                manager.createNotificationChannel(nativeChannel);
            }
            NotificationChannel activeChannel = manager.getNotificationChannel(channel);
            if (activeChannel == null || activeChannel.getImportance() == NotificationManager.IMPORTANCE_NONE) return;
            // Only the app's own launcher is an intent target; data cannot name components/URLs.
            Intent tap = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (tap == null || tap.getComponent() == null
                || !getPackageName().equals(tap.getComponent().getPackageName())) return;
            tap.setAction(getPackageName() + ".REMINDER." + id);
            tap.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            tap.putExtra("google.message_id", message.getMessageId() == null ? id : message.getMessageId());
            tap.putExtra("notificationId", id);
            tap.putExtra("category", "reminder");
            tap.putExtra("priority", priority);
            for (String selector : new String[]{"conversationId", "messageId"}) {
                String value = data.get(selector);
                if (value != null && NOTIFICATION_ID.matcher(value).matches()) {
                    tap.putExtra(selector, value.toLowerCase(java.util.Locale.ROOT));
                }
            }
            String deepLink = data.get("deepLink");
            if (deepLink != null && deepLink.length() <= 2048 && deepLink.indexOf('\\') < 0
                && deepLink.chars().noneMatch(Character::isISOControl)) tap.putExtra("deepLink", deepLink);
            // The existing native URL buffer and durable chat-launch controller
            // retain cold /chat opens until the renderer owner mounts. The URI is
            // app configuration + a constant route, never a producer-supplied URL.
            if ("/chat".equals(deepLink)) {
                int schemeId = getResources().getIdentifier("custom_url_scheme", "string", getPackageName());
                if (schemeId != 0) {
                    String scheme = getString(schemeId);
                    if (scheme.matches("[A-Za-z][A-Za-z0-9+.-]*") && !"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                        tap.setAction(Intent.ACTION_VIEW);
                        Uri.Builder route = new Uri.Builder().scheme(scheme).authority("chat")
                            .appendQueryParameter("notificationId", id);
                        for (String selector : new String[]{"conversationId", "messageId"}) {
                            if (tap.hasExtra(selector)) route.appendQueryParameter(selector, tap.getStringExtra(selector));
                        }
                        tap.setData(route.build());
                    }
                }
            }
            PendingIntent pending = PendingIntent.getActivity(
                this, 0, tap, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            android.app.Notification notification = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
                .build();
            // Canonical tag + constant ID has no hash collisions. A crash before the
            // receipt commits replaces an active notification instead of stacking it.
            try {
                manager.notify("eliza.reminder:" + id, 0, notification);
            } catch (SecurityException revoked) {
                Log.w(TAG, "Notification permission was revoked during delivery");
                return;
            }
            if (!receipts.edit().putLong(id, now).commit()) {
                Log.w(TAG, "Could not persist reminder delivery receipt");
            }
        }
    }
}
