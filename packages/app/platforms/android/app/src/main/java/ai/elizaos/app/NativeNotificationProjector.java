package ai.elizaos.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.system.Os;
import android.system.OsConstants;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.file.Path;
import java.util.UUID;
import org.json.JSONObject;

/** Non-GMS native projection. Transport/inbox authority stays outside the presentation layer.
 * Never consumes FCM receipts or accepts a producer-provided component, scheme or external URL. */
final class NativeNotificationProjector {
    private static final String PREFS = "eliza_native_notification_taps";
    private static final String OWNER = "elizaNativeNotificationOwner", TOKEN = "elizaNativeNotificationToken";
    private static final String TAG = "eliza.native.notification:";
    private static final String GROUP = "elizaNativeNotificationGroup";

    static boolean post(Context context, String owner, JSONObject notification) throws Exception {
        if (!validOwner(owner)) throw new SecurityException("Invalid notification presentation owner");
        JSONObject item = NativeNotificationInbox.checked(notification);
        if ((Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        String priority = item.getString("priority");
        JSONObject data = item.optJSONObject("data");
        String ownerType = "reminder".equals(item.getString("category")) && data != null ? data.optString("ownerType", "") : "";
        NotificationChannel selected = ElizaReminderMessagingService.resolveReminderChannel(manager, priority, ownerType);
        if (manager.getNotificationChannel(selected.getId()) == null) {
            selected.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(selected);
        }
        if (ElizaReminderMessagingService.isReminderChannelBlocked(manager, manager.getNotificationChannel(selected.getId()))) return false;
        String id = item.getString("id"), key = owner + ":" + id, token = UUID.randomUUID().toString();
        SharedPreferences receipts = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!receipts.edit().putString(key, token).commit()) throw new IOException("Notification tap authority could not be persisted");
        Intent tap = new Intent(context, MainActivity.class)
                .setAction(context.getPackageName() + ".NATIVE_NOTIFICATION." + key)
                .setData(new Uri.Builder().scheme("eliza-native-notification").authority(owner).appendPath(id).build())
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(OWNER, owner).putExtra(TOKEN, token).putExtra("notificationId", id)
                .putExtra("category", item.getString("category"));
        String deepLink = item.optString("deepLink", "");
        if (NativeNotificationRoute.view(deepLink) != null) tap.putExtra("deepLink", deepLink);
        if ("/chat".equals(deepLink)) {
            for (String field : new String[]{"conversationId", "messageId"}) {
                String value = data == null ? null : data.optString(field, null);
                if (validId(value)) tap.putExtra(field, value.toLowerCase(java.util.Locale.ROOT));
            }
        }
        String group = item.optString("groupKey", "");
        if (group.length() > 512 || group.chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException("Invalid notification group");
        android.os.Bundle extras = new android.os.Bundle(); extras.putString(OWNER, owner); extras.putString(GROUP, group);
        android.app.Notification post = new NotificationCompat.Builder(context, selected.getId())
                .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(item.getString("title"))
                .setContentText(item.getString("body")).setStyle(new NotificationCompat.BigTextStyle().bigText(item.getString("body")))
                .setVisibility(android.app.Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(context, 0, tap, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .addExtras(extras).build();
        String tag = TAG + key;
        manager.notify(tag, 0, post);
        boolean accepted = false;
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (active.getId() == 0 && tag.equals(active.getTag()) && owner.equals(active.getNotification().extras.getString(OWNER))) accepted = true;
        }
        if (!accepted) return false;
        if (!group.isEmpty()) {
            SharedPreferences.Editor retired = receipts.edit();
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                String previous = active.getTag();
                if (active.getId() == 0 && previous != null && previous.startsWith(TAG + owner + ":") && !tag.equals(previous)
                        && owner.equals(active.getNotification().extras.getString(OWNER)) && group.equals(active.getNotification().extras.getString(GROUP))) {
                    manager.cancel(previous, 0); retired.remove(previous.substring(TAG.length()));
                }
            }
            if (!retired.commit()) throw new IOException("Replaced notification tap could not be retired");
        }
        return true;
    }

    /** Call before native deep-link capture. Only current-profile, private-token taps become routes. */
    static boolean onOpened(Context context, Intent intent, String currentOwner) {
        if (intent == null || !intent.hasExtra(OWNER)) return false;
        String owner = intent.getStringExtra(OWNER), id = intent.getStringExtra("notificationId");
        SharedPreferences receipts = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean verified = validOwner(currentOwner) && currentOwner.equals(owner) && validId(id)
                && (context.getPackageName() + ".NATIVE_NOTIFICATION." + owner + ":" + id).equals(intent.getAction())
                && intent.getComponent() != null && context.getPackageName().equals(intent.getComponent().getPackageName())
                && MainActivity.class.getName().equals(intent.getComponent().getClassName())
                && java.util.Objects.equals(receipts.getString(owner + ":" + id, null), intent.getStringExtra(TOKEN))
                && intent.getStringExtra(TOKEN) != null;
        // Neither a stale profile tap nor an unverified producer route enters the URL buffer.
        intent.setData(null).setAction(Intent.ACTION_MAIN);
        if (!verified) { intent.removeExtra("deepLink"); intent.removeExtra("conversationId"); intent.removeExtra("messageId"); return false; }
        if (!receipts.edit().remove(owner + ":" + id).commit()) {
            intent.removeExtra("deepLink"); intent.removeExtra("conversationId"); intent.removeExtra("messageId"); return false;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(TAG + owner + ":" + id, 0);
        int resource = context.getResources().getIdentifier("custom_url_scheme", "string", context.getPackageName());
        String scheme = resource == 0 ? null : context.getString(resource);
        String route = NativeNotificationRoute.uri(scheme, intent.getStringExtra("deepLink"), id,
                intent.getStringExtra("conversationId"), intent.getStringExtra("messageId"));
        if (route != null) intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse(route));
        return true;
    }
    /** Retire only this transport's exact owner scope, including NMS posts still pending visibility. */
    static void retireOwner(Context context, String owner) throws IOException {
        if (!validOwner(owner)) throw new SecurityException("Invalid notification retirement owner");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        SharedPreferences receipts = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor retired = receipts.edit();
        String prefix = owner + ":";
        for (String key : receipts.getAll().keySet()) {
            if (key.startsWith(prefix) && validId(key.substring(prefix.length()))) {
                if (manager != null) manager.cancel(TAG + key, 0);
                retired.remove(key);
            }
        }
        if (manager != null) {
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                String tag = active.getTag();
                if (active.getId() == 0 && tag != null && tag.startsWith(TAG + prefix)
                        && owner.equals(active.getNotification().extras.getString(OWNER))
                        && validId(tag.substring((TAG + prefix).length()))) manager.cancel(tag, 0);
            }
        }
        if (!retired.commit()) throw new IOException("Native notification owner retirement could not be saved");
    }

    private static boolean validOwner(String value) { return value != null && value.matches("[a-f0-9]{64}"); }
    private static boolean validId(String value) { return value != null && value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"); }

    static void syncDirectory(Path directory) throws IOException {
        FileDescriptor descriptor = null;
        try { descriptor = Os.open(directory.toString(), OsConstants.O_RDONLY, 0); Os.fsync(descriptor); }
        catch (android.system.ErrnoException error) { throw new IOException("Native notification directory could not be synced", error); }
        finally { if (descriptor != null) try { Os.close(descriptor); } catch (android.system.ErrnoException error) { throw new IOException("Native notification directory could not be closed", error); } }
    }
}
