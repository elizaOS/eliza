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
import java.util.LinkedHashMap;
import java.util.UUID;
import android.service.notification.StatusBarNotification;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;

/** Projects negotiated reminder data without a WebView. The server inbox stays authoritative. */
public final class ElizaReminderMessagingService extends MessagingService {
    private static final String TAG = "ElizaReminderPush";
    private static final String RECEIPTS = "eliza_reminder_push_receipts";
    private static final Object DELIVERY_LOCK = new Object();
    private static final String TAP_TOKEN_PREFIX = "tap:";
    private static final String TAP_TOKEN_EXTRA = "elizaReminderTapToken";
    private static final String GROUP_PREFIX = "eliza.reminders.channel:";
    private static final String SUMMARY_PREFIX = "eliza.reminder.summary:";
    private static final String BACKEND_GROUP_EXTRA = "elizaReminderBackendGroup";
    // Bridge only posts that NMS has accepted but has not exposed in its snapshot.
    // This is transient presentation state; receipts remain the durable authority.
    private static final Map<String, android.app.Notification> pendingChildren = new LinkedHashMap<>();
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

    @Override
    public void onMessageReceived(RemoteMessage message) {
        if (message.getNotification() == null && "1".equals(message.getData().get("elizaReminderData"))) {
            projectReminder(this, message.getData(), message.getMessageId());
        }
        // Keep standard token/notification transport and the Capacitor data event.
        super.onMessageReceived(message);
    }

    static boolean projectReminder(Context context, Map<String, String> data, String transportId) {
        String id = data.get("notificationId");
        String title = data.get("title");
        String body = data.get("body");
        String priority = data.get("priority");
        String backendGroup = data.get("groupKey");
        if (backendGroup != null && (backendGroup.trim().isEmpty() || backendGroup.length() > 512
            || backendGroup.chars().anyMatch(Character::isISOControl))) return false;
        if (!"reminder".equals(data.get("category")) || id == null
            || !NOTIFICATION_ID.matcher(id).matches() || title == null
            || title.trim().isEmpty() || title.length() > 512 || title.indexOf('\0') >= 0
            || body == null || body.length() > 4096 || body.indexOf('\0') >= 0) return false;
        if (!"urgent".equals(priority) && !"high".equals(priority)
            && !"normal".equals(priority) && !"low".equals(priority)) return false;
        id = id.toLowerCase(java.util.Locale.ROOT);
        synchronized (DELIVERY_LOCK) {
            SharedPreferences receipts = context.getSharedPreferences(RECEIPTS, Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            long cutoff = now - RECEIPT_LIFETIME_MS;
            SharedPreferences.Editor pruning = receipts.edit();
            boolean pruned = false;
            Map<String, ?> stored = receipts.getAll();
            for (Map.Entry<String, ?> entry : stored.entrySet()) {
                String key = entry.getKey();
                if (key.startsWith(TAP_TOKEN_PREFIX)) {
                    String receiptId = key.substring(TAP_TOKEN_PREFIX.length());
                    Object recorded = stored.get(receiptId);
                    if (!NOTIFICATION_ID.matcher(receiptId).matches()
                        || !(entry.getValue() instanceof String)
                        || !NOTIFICATION_ID.matcher((String) entry.getValue()).matches()
                        || !(recorded instanceof Long) || ((Long) recorded) <= cutoff) {
                        pruning.remove(key);
                        pruned = true;
                    }
                } else if (!(entry.getValue() instanceof Long) || ((Long) entry.getValue()) <= cutoff) {
                    pruning.remove(key).remove(TAP_TOKEN_PREFIX + key);
                    pruned = true;
                }
            }
            if (pruned && !pruning.commit()) Log.w(TAG, "Could not prune expired delivery receipts");
            Object recordedAt = receipts.getAll().get(id);
            if (recordedAt instanceof Long && ((Long) recordedAt) > cutoff) return true;
            if ((Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                    context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return false;
            NotificationChannel selected = resolveReminderChannel(manager, priority, data.get("ownerType"));
            String channel = selected.getId();
            if (manager.getNotificationChannel(channel) == null) {
                selected.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                manager.createNotificationChannel(selected);
            }
            NotificationChannel activeChannel = manager.getNotificationChannel(channel);
            if (isReminderChannelBlocked(manager, activeChannel)) return false;
            // Only the app's own launcher is an intent target; data cannot name components/URLs.
            Intent tap = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            if (tap == null || tap.getComponent() == null
                || !context.getPackageName().equals(tap.getComponent().getPackageName())) return false;
            tap.setAction(context.getPackageName() + ".REMINDER." + id);
            tap.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            tap.putExtra("google.message_id", transportId == null ? id : transportId);
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
                int schemeId = context.getResources().getIdentifier("custom_url_scheme", "string", context.getPackageName());
                if (schemeId != 0) {
                    String scheme = context.getString(schemeId);
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
            String tapToken = UUID.randomUUID().toString();
            if (!receipts.edit().putString(TAP_TOKEN_PREFIX + id, tapToken).commit()) {
                Log.w(TAG, "Could not persist reminder tap provenance");
                return false;
            }
            tap.putExtra(TAP_TOKEN_EXTRA, tapToken);
            PendingIntent pending = PendingIntent.getActivity(
                context, 0, tap, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            android.app.Notification notification = new NotificationCompat.Builder(context, channel)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
                .setGroup(GROUP_PREFIX + channel)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setDeleteIntent(PendingIntent.getBroadcast(context, 0,
                    new Intent(context, ReminderNotificationDismissReceiver.class)
                        .setAction(context.getPackageName() + ".REMINDER_DISMISSED." + id)
                        .putExtra("notificationId", id).putExtra(TAP_TOKEN_EXTRA, tapToken),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .build();
            if (backendGroup != null) notification.extras.putString(BACKEND_GROUP_EXTRA, backendGroup);
            // Canonical tag + constant ID has no hash collisions. A crash before the
            // receipt commits replaces an active notification instead of stacking it.
            try {
                // Retain prior immediate posts until NMS exposes them too.
                pendingChildren.put(id, notification);
                reconcileSummary(context, manager, channel, null, id, notification);
                manager.notify("eliza.reminder:" + id, 0, notification);
            } catch (SecurityException revoked) {
                Log.w(TAG, "Notification permission was revoked during delivery");
                pendingChildren.remove(id);
                receipts.edit().remove(TAP_TOKEN_PREFIX + id).commit();
                reconcileSummary(context, manager, channel, id, null, null);
                return false;
            }
            if (backendGroup != null) {
                java.util.Set<String> replaced = new java.util.HashSet<>();
                for (StatusBarNotification active : manager.getActiveNotifications()) {
                    if (isReminderChannel(active.getNotification().getChannelId())
                        && isOwnChild(active, active.getNotification().getChannelId())
                        && backendGroup.equals(active.getNotification().extras.getString(BACKEND_GROUP_EXTRA))) {
                        String previous = active.getTag().substring("eliza.reminder:".length());
                        if (!previous.equals(id)) replaced.add(previous);
                    }
                }
                for (Map.Entry<String, android.app.Notification> acceptedPost : pendingChildren.entrySet()) {
                    if (!acceptedPost.getKey().equals(id) && backendGroup.equals(acceptedPost.getValue().extras.getString(BACKEND_GROUP_EXTRA)))
                        replaced.add(acceptedPost.getKey());
                }
                retireOwnChildren(context, manager, replaced);
                for (String affected : new String[]{"eliza_alerts", "eliza_notifications", "eliza_updates", "eliza_quiet"})
                    reconcileSummary(context, manager, affected, null, null, null);
            }
            if (!receipts.edit().putLong(id, now).commit()) {
                Log.w(TAG, "Could not persist reminder delivery receipt");
            }
            return true;
        }
    }

    /** Launcher extras are untrusted; only the private per-child token can retire it. */
    static void onReminderOpened(Context context, Intent intent) {
        removeOwnedChild(context, intent, ".REMINDER.");
    }

    static void onReminderDismissed(Context context, Intent intent) {
        removeOwnedChild(context, intent, ".REMINDER_DISMISSED.");
    }

    private static void removeOwnedChild(Context context, Intent intent, String actionPrefix) {
        if (intent == null) return;
        String id = intent.getStringExtra("notificationId");
        if (id == null || !NOTIFICATION_ID.matcher(id).matches()
            || !isOwnChildIntent(context, intent, id, actionPrefix)) return;
        synchronized (DELIVERY_LOCK) {
            SharedPreferences receipts = context.getSharedPreferences(RECEIPTS, Context.MODE_PRIVATE);
            Object expected = receipts.getAll().get(TAP_TOKEN_PREFIX + id);
            if (!(expected instanceof String) || !expected.equals(intent.getStringExtra(TAP_TOKEN_EXTRA))) return;
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return;
            retireOwnChildren(context, manager, java.util.Collections.singleton(id));
            // The removed key is excluded even while NMS cancellation is pending.
            for (String channel : new String[]{"eliza_alerts", "eliza_notifications", "eliza_updates", "eliza_quiet"}) {
                reconcileSummary(context, manager, channel, id, null, null);
            }
        }
    }

    private static boolean isOwnChildIntent(Context context, Intent intent, String id, String actionPrefix) {
        if ((context.getPackageName() + actionPrefix + id).equals(intent.getAction()))
            return intent.getData() == null && (!".REMINDER.".equals(actionPrefix)
                || "reminder".equals(intent.getStringExtra("category")));
        if (!".REMINDER.".equals(actionPrefix) || !Intent.ACTION_VIEW.equals(intent.getAction())
            || !"reminder".equals(intent.getStringExtra("category"))
            || !"/chat".equals(intent.getStringExtra("deepLink"))) return false;
        Uri uri = intent.getData();
        int schemeId = context.getResources().getIdentifier("custom_url_scheme", "string", context.getPackageName());
        if (uri == null || schemeId == 0 || !context.getString(schemeId).equals(uri.getScheme())
            || !"chat".equals(uri.getAuthority()) || (uri.getPath() != null && !uri.getPath().isEmpty())
            || uri.getFragment() != null || !id.equals(uri.getQueryParameter("notificationId"))) return false;
        for (String name : uri.getQueryParameterNames()) {
            if (!"notificationId".equals(name) && !"conversationId".equals(name) && !"messageId".equals(name)) return false;
            if (uri.getQueryParameters(name).size() != 1) return false;
        }
        for (String name : new String[]{"conversationId", "messageId"}) {
            String value = intent.getStringExtra(name);
            if (value != null && !NOTIFICATION_ID.matcher(value).matches()) return false;
            if (!java.util.Objects.equals(value, uri.getQueryParameter(name))) return false;
        }
        return true;
    }

    /** Called only by the non-exported summary delete PendingIntent. */
    static void onReminderGroupDismissed(Context context, String channel) {
        if (!isReminderChannel(channel)) return;
        synchronized (DELIVERY_LOCK) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return;
            java.util.Set<String> removed = new java.util.HashSet<>();
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                if (isOwnChild(active, channel)) removed.add(active.getTag().substring("eliza.reminder:".length()));
            }
            for (Map.Entry<String, android.app.Notification> pending : pendingChildren.entrySet()) {
                if (channel.equals(pending.getValue().getChannelId())) removed.add(pending.getKey());
            }
            retireOwnChildren(context, manager, removed);
            manager.cancel(SUMMARY_PREFIX + channel, 0);
        }
    }

    private static void retireOwnChildren(Context context, NotificationManager manager, java.util.Set<String> ids) {
        if (ids.isEmpty()) return;
        SharedPreferences.Editor retired = context.getSharedPreferences(RECEIPTS, Context.MODE_PRIVATE).edit();
        for (String id : ids) {
            retired.remove(TAP_TOKEN_PREFIX + id);
            pendingChildren.remove(id);
            manager.cancel("eliza.reminder:" + id, 0);
        }
        if (!retired.commit()) Log.w(TAG, "Could not retire reminder tap provenance");
    }

    private static boolean isReminderChannel(String channel) {
        return "eliza_alerts".equals(channel) || "eliza_notifications".equals(channel)
            || "eliza_updates".equals(channel) || "eliza_quiet".equals(channel);
    }

    private static boolean isOwnChild(StatusBarNotification active, String channel) {
        return active.getId() == 0 && active.getTag() != null
            && active.getTag().startsWith("eliza.reminder:")
            && NOTIFICATION_ID.matcher(active.getTag().substring("eliza.reminder:".length())).matches()
            && channel.equals(active.getNotification().getChannelId())
            && (GROUP_PREFIX + channel).equals(active.getNotification().getGroup());
    }

    private static void reconcileSummary(Context context, NotificationManager manager, String channel,
            String excludedId, String pendingId, android.app.Notification pending) {
        Map<String, android.app.Notification> children = new LinkedHashMap<>();
        SharedPreferences receipts = context.getSharedPreferences(RECEIPTS, Context.MODE_PRIVATE);
        Map<String, ?> stored = receipts.getAll();
        // Retired token absence survives process restarts and excludes cancel-pending
        // snapshots without another persistent lifecycle record.
        pendingChildren.keySet().removeIf(id -> !(stored.get(TAP_TOKEN_PREFIX + id) instanceof String));
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (isOwnChild(active, channel)) {
                String id = active.getTag().substring("eliza.reminder:".length());
                pendingChildren.remove(id);
                if (!id.equals(excludedId) && stored.get(TAP_TOKEN_PREFIX + id) instanceof String)
                    children.put(id, active.getNotification());
            }
        }
        for (Map.Entry<String, android.app.Notification> entry : pendingChildren.entrySet()) {
            if (channel.equals(entry.getValue().getChannelId()) && !entry.getKey().equals(excludedId))
                children.put(entry.getKey(), entry.getValue());
        }
        if (pendingId != null && pending != null && !pendingId.equals(excludedId)) children.put(pendingId, pending);
        if (children.isEmpty()) {
            manager.cancel(SUMMARY_PREFIX + channel, 0);
            return;
        }
        NotificationChannel selected = manager.getNotificationChannel(channel);
        if (selected == null || selected.getImportance() == NotificationManager.IMPORTANCE_NONE
            || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open == null || open.getComponent() == null
            || !context.getPackageName().equals(open.getComponent().getPackageName())) return;
        open.setAction(context.getPackageName() + ".REMINDER_SUMMARY." + channel);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // Ordinary launcher only: a summary is not a canonical child/read target.
        NotificationCompat.InboxStyle lines = new NotificationCompat.InboxStyle();
        for (android.app.Notification child : children.values()) {
            lines.addLine(child.extras.getCharSequence(android.app.Notification.EXTRA_TEXT, ""));
        }
        android.app.Notification summary = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Reminders")
            .setStyle(lines).setGroup(GROUP_PREFIX + channel).setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
            .setDeleteIntent(PendingIntent.getBroadcast(context, 0,
                new Intent(context, ReminderNotificationDismissReceiver.class)
                    .setAction(context.getPackageName() + ".REMINDER_GROUP_DISMISSED." + channel)
                    .putExtra("channelId", channel),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
            .build();
        manager.notify(SUMMARY_PREFIX + channel, 0, summary);
    }

}
