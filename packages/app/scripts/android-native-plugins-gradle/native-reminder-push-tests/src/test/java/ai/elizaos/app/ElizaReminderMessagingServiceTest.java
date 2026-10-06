package ai.elizaos.app;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.os.Bundle;
import java.util.concurrent.TimeUnit;
import android.service.notification.StatusBarNotification;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.RemoteMessage;

import java.util.HashMap;
import java.util.Map;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Executes the production receiver in Android's host framework, without a device/WebView/Google send. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 29, 36}, application = android.app.Application.class)
public class ElizaReminderMessagingServiceTest {
    private static final String A = "11111111-1111-4111-8111-111111111111";
    private static final String B = "22222222-2222-4222-8222-222222222222";
    private Context context;
    private NotificationManager manager;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        manager = context.getSystemService(NotificationManager.class);
        context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).edit().clear().commit();
        PushNotificationsPlugin.staticBridge = null;
        PushNotificationsPlugin.lastMessage = null;
        ResolveInfo activity = new ResolveInfo();
        activity.activityInfo = new ActivityInfo();
        activity.activityInfo.packageName = context.getPackageName();
        activity.activityInfo.name = context.getPackageName() + ".MainActivity";
        activity.activityInfo.applicationInfo = context.getApplicationInfo();
        shadowOf(context.getPackageManager()).addResolveInfoForIntent(
            new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.getPackageName()), activity
        );
    }
    private StatusBarNotification[] reminderChildren() {
        return java.util.Arrays.stream(manager.getActiveNotifications())
            .filter(n -> n.getTag() != null && n.getTag().startsWith("eliza.reminder:"))
            .toArray(StatusBarNotification[]::new);
    }
    private Notification summary(String channel) {
        return java.util.Arrays.stream(manager.getActiveNotifications())
            .filter(n -> ("eliza.reminder.summary:" + channel).equals(n.getTag()))
            .findFirst().map(StatusBarNotification::getNotification).orElse(null);
    }
    private ElizaReminderMessagingService receiver() {
        return Robolectric.buildService(ElizaReminderMessagingService.class).create().get();
    }
    private Map<String, String> data(String id) {
        Map<String, String> data = new HashMap<>();
        data.put("elizaReminderData", "1"); data.put("category", "reminder");
        data.put("notificationId", id); data.put("title", "Same reminder title");
        data.put("body", "Saved reminder body"); data.put("priority", "normal");
        data.put("deepLink", "/notifications");
        return data;
    }
    private RemoteMessage message(Map<String, String> data, String googleId) {
        Bundle bundle = new Bundle();
        for (Map.Entry<String, String> entry : data.entrySet()) bundle.putString(entry.getKey(), entry.getValue());
        bundle.putString("google.message_id", googleId);
        return new RemoteMessage(bundle);
    }
    @Test public void twoColdRemindersUseDistinctCanonicalIdentitiesAndStockTapMetadata() {
        ElizaReminderMessagingService service = receiver();
        service.onMessageReceived(message(data(A), "google-a"));
        service.onMessageReceived(message(data(B), "google-b"));
        StatusBarNotification[] delivered = reminderChildren();
        assertEquals(2, delivered.length);
        assertNotEquals(delivered[0].getTag(), delivered[1].getTag());
        for (StatusBarNotification row : delivered) {
            assertEquals(0, row.getId());
            assertEquals("eliza_updates", row.getNotification().getChannelId());
            Intent tap = shadowOf(row.getNotification().contentIntent).getSavedIntent();
            assertEquals(context.getPackageName(), tap.getComponent().getPackageName());
            assertNull(tap.getData());
            assertEquals("/notifications", tap.getStringExtra("deepLink"));
            assertEquals("normal", tap.getStringExtra("priority"));
            assertEquals("eliza.reminder:" + tap.getStringExtra("notificationId"), row.getTag());
            assertTrue(tap.hasExtra("google.message_id"));
        }
        // The SDK data event remains available to a later Capacitor bridge.
        assertEquals(B, PushNotificationsPlugin.lastMessage.getData().get("notificationId"));
    }
    @Test public void redeliveryAfterDismissalAndNewReceiverDoesNotProjectAgain() {
        receiver().onMessageReceived(message(data(A), "google-first"));
        manager.cancelAll();
        receiver().onMessageReceived(message(data(A), "google-redelivery"));
        assertEquals(0, reminderChildren().length);
        assertTrue(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).getLong(A, 0) > 0);
    }
    @Test public void receiptsCoverTheEntireFcmLifetimeThenExpire() {
        receiver().onMessageReceived(message(data(A), "first"));
        manager.cancelAll();
        context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).edit()
            .putLong(A, System.currentTimeMillis() - TimeUnit.DAYS.toMillis(28) + 60_000).commit();
        receiver().onMessageReceived(message(data(A), "still-live"));
        assertEquals(0, reminderChildren().length);
        context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).edit()
            .putLong(A, System.currentTimeMillis() - TimeUnit.DAYS.toMillis(28) - 1).commit();
        receiver().onMessageReceived(message(data(A), "new-after-retention"));
        assertEquals(1, reminderChildren().length);
    }
    @Test public void expiredReceiptsArePrunedWithoutARandomCountEviction() {
        long now = System.currentTimeMillis();
        android.content.SharedPreferences prefs = context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE);
        android.content.SharedPreferences.Editor edit = prefs.edit();
        for (int i = 0; i < 300; i++) edit.putLong(java.util.UUID.randomUUID().toString(), now - TimeUnit.DAYS.toMillis(28) - 1);
        edit.putLong(B, now);
        edit.commit();
        receiver().onMessageReceived(message(data(A), "current"));
        assertEquals(2L, prefs.getAll().values().stream().filter(value -> value instanceof Long).count());
        assertTrue(prefs.getAll().get("tap:" + A) instanceof String);
        assertTrue(prefs.contains(B));
        assertTrue(prefs.contains(A));
    }
    @Test public void foregroundProcessUsesTheSameProjectionAndDeduplication() {
        Robolectric.buildActivity(Activity.class).setup();
        ElizaReminderMessagingService service = receiver();
        service.onMessageReceived(message(data(A), "google-first"));
        service.onMessageReceived(message(data(A), "google-repeat"));
        assertEquals(1, reminderChildren().length);
        assertTrue((reminderChildren()[0].getNotification().flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0);
    }
    @Test public void coldChatTapSurvivesBridgeReplacementThroughTheExistingUrlBuffer() {
        Map<String, String> data = data(A); data.put("deepLink", "/chat");
        data.put("conversationId", B); data.put("messageId", A);
        data.put("voice", "1"); data.put("action", "send");
        receiver().onMessageReceived(message(data, "cold-launch"));
        Intent tap = shadowOf(reminderChildren()[0].getNotification().contentIntent).getSavedIntent();
        assertEquals(Intent.ACTION_VIEW, tap.getAction());
        assertEquals("elizaos", tap.getData().getScheme());
        assertEquals("chat", tap.getData().getHost());
        assertEquals(A, tap.getData().getQueryParameter("notificationId"));
        assertEquals(B, tap.getData().getQueryParameter("conversationId"));
        assertEquals(A, tap.getData().getQueryParameter("messageId"));
        assertNull(tap.getData().getQueryParameter("voice"));
        assertNull(tap.getData().getQueryParameter("action"));
        // MainActivity executes this same capture before building the Capacitor bridge.
        DeepLinkBufferPlugin.captureIntent(context, tap);
        String persisted = context.getSharedPreferences("eliza_deep_link_buffer", Context.MODE_PRIVATE)
            .getString("pending_url", null);
        assertEquals(tap.getData().toString(), persisted);
        // The launch metadata is also retained for the replacement push plugin.
        assertEquals("cold-launch", tap.getStringExtra("google.message_id"));
        assertEquals("/chat", tap.getStringExtra("deepLink"));
    }
    @Config(sdk = 36) // POST_NOTIFICATIONS is a runtime permission from API 33.
    @Test public void deniedNotificationPermissionDoesNotPostOrConsumeReceipt() {
        shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.POST_NOTIFICATIONS);
        receiver().onMessageReceived(message(data(A), "denied"));
        assertEquals(0, reminderChildren().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        receiver().onMessageReceived(message(data(A), "granted"));
        assertEquals(1, reminderChildren().length);
    }
    @Test public void channelsPreserveSystemDndPolicy() {
        Map<String, String> data = data(A); data.put("priority", "urgent");
        receiver().onMessageReceived(message(data, "urgent"));
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel("eliza_alerts").getImportance());
        assertFalse(manager.getNotificationChannel("eliza_alerts").canBypassDnd());
    }
    @Test public void normalCalendarReminderKeepsDefaultTier() {
        receiver().onMessageReceived(message(data(A), "normal-calendar"));
        assertEquals("eliza_updates", reminderChildren()[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel("eliza_updates").getImportance());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test public void highOccurrenceUsesExistingHeadsUpTierWithoutBypassingDnd() {
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "high-alert"));
        NotificationChannel channel = manager.getNotificationChannel("eliza_notifications");
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.getImportance());
        assertFalse(channel.canBypassDnd());
    }
    @Test public void explicitLowReminderStaysQuiet() {
        Map<String, String> quiet = data(A); quiet.put("priority", "low");
        receiver().onMessageReceived(message(quiet, "quiet"));
        assertEquals("eliza_quiet", reminderChildren()[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("eliza_quiet").getImportance());
    }
    @Test public void existingQuietUpdatesChoiceIsPreserved() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Quiet", NotificationManager.IMPORTANCE_LOW));
        receiver().onMessageReceived(message(data(A), "user-quiet"));
        assertEquals("eliza_updates", reminderChildren()[0].getNotification().getChannelId());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test @Config(sdk = {26, 29}) public void legacyDefaultImportanceCustomSoundIsPreserved() {
        NotificationChannel updates = new NotificationChannel("eliza_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT);
        android.net.Uri sound = android.net.Uri.parse("content://media/internal/audio/media/42");
        updates.setSound(sound, new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION).build());
        manager.createNotificationChannel(updates);
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "legacy-sound"));
        assertEquals("eliza_updates", reminderChildren()[0].getNotification().getChannelId());
        assertEquals(sound, manager.getNotificationChannel("eliza_updates").getSound());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test public void existingBlockedAlertChannelIsNotOverridden() {
        manager.createNotificationChannel(new NotificationChannel("eliza_notifications", "Blocked", NotificationManager.IMPORTANCE_NONE));
        Map<String, String> high = data(A); high.put("priority", "high");
        receiver().onMessageReceived(message(high, "blocked-alert"));
        assertEquals(0, manager.getActiveNotifications().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
    }
    @Test public void mutedChannelDoesNotPostOrConsumeReceipt() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Muted", NotificationManager.IMPORTANCE_NONE));
        receiver().onMessageReceived(message(data(A), "muted"));
        assertEquals(0, reminderChildren().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
    }
    @Test public void existingQuietHighTierIsPreservedForOccurrenceAlerts() {
        manager.createNotificationChannel(new NotificationChannel("eliza_notifications", "Quiet", NotificationManager.IMPORTANCE_LOW));
        Map<String, String> high = data(A); high.put("priority", "high");
        receiver().onMessageReceived(message(high, "quiet-high"));
        assertEquals("eliza_notifications", reminderChildren()[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("eliza_notifications").getImportance());
    }
    @Test public void occurrenceHighPreservesLegacyQuietUpdates() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Quiet", NotificationManager.IMPORTANCE_LOW));
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "occurrence-quiet"));
        assertEquals("eliza_updates", reminderChildren()[0].getNotification().getChannelId());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test public void occurrenceHighPreservesLegacyMutedUpdatesWithoutReceipt() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Muted", NotificationManager.IMPORTANCE_NONE));
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "occurrence-muted"));
        assertEquals(0, manager.getActiveNotifications().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
    }
    @Test public void occurrenceHighUsesAlertWhenLegacyUpdatesIsUntouched() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT));
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "occurrence-default"));
        assertEquals(android.os.Build.VERSION.SDK_INT < 30 ? "eliza_updates" : "eliza_notifications", reminderChildren()[0].getNotification().getChannelId());
    }
    @Test public void calendarHighDoesNotInheritOccurrenceLegacyChoice() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Quiet", NotificationManager.IMPORTANCE_LOW));
        Map<String, String> calendar = data(A); calendar.put("priority", "high"); calendar.put("ownerType", "calendar_event");
        receiver().onMessageReceived(message(calendar, "calendar-high"));
        assertEquals("eliza_notifications", reminderChildren()[0].getNotification().getChannelId());
    }
    @Test public void occurrenceAlertPreservesRestrictiveVisibility() {
        NotificationChannel updates = new NotificationChannel("eliza_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT);
        updates.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(updates);
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "private-occurrence"));
        assertEquals("eliza_updates", reminderChildren()[0].getNotification().getChannelId());
        assertEquals(Notification.VISIBILITY_PRIVATE, manager.getNotificationChannel("eliza_updates").getLockscreenVisibility());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test public void occurrenceAlertPreservesExistingGroup() {
        manager.createNotificationChannelGroup(new android.app.NotificationChannelGroup("reminders", "Reminders"));
        NotificationChannel updates = new NotificationChannel("eliza_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT);
        updates.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        updates.setGroup("reminders");
        manager.createNotificationChannel(updates);
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "grouped-occurrence"));
        assertEquals("eliza_updates", reminderChildren()[0].getNotification().getChannelId());
        assertEquals("reminders", manager.getNotificationChannel("eliza_updates").getGroup());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Config(sdk = {29, 36})
    @Test public void blockedGroupDoesNotConsumeReceiptAndCanLaterDeliver() {
        android.app.NotificationChannelGroup group = new android.app.NotificationChannelGroup("muted-reminders", "Muted reminders");
        org.robolectric.util.ReflectionHelpers.setField(group, "mBlocked", true);
        manager.createNotificationChannelGroup(group);
        NotificationChannel updates = new NotificationChannel("eliza_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT);
        updates.setGroup("muted-reminders");
        manager.createNotificationChannel(updates);
        assertTrue(manager.getNotificationChannelGroup("muted-reminders").isBlocked());
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        receiver().onMessageReceived(message(occurrence, "blocked-group"));
        assertEquals(0, manager.getActiveNotifications().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
        org.robolectric.util.ReflectionHelpers.setField(group, "mBlocked", false);
        manager.createNotificationChannelGroup(group);
        assertFalse(manager.getNotificationChannelGroup("muted-reminders").isBlocked());
        receiver().onMessageReceived(message(occurrence, "unblocked-group"));
        assertEquals(1, reminderChildren().length);
        assertTrue(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
    }
    @Test public void firstAndAccumulatedChildrenHaveRealSummaryWithoutAbsorbingLegacyRows() {
        manager.notify("eliza.reminder:33333333-3333-4333-8333-333333333333", 0,
            new android.app.Notification.Builder(context, "eliza_updates").setContentTitle("Legacy").build());
        receiver().onMessageReceived(message(data(A), "first"));
        receiver().onMessageReceived(message(data(B), "second"));
        Notification group = summary("eliza_updates");
        assertNotNull(group);
        assertEquals("Reminders", group.extras.getString(Notification.EXTRA_TITLE));
        assertEquals("eliza.reminders.channel:eliza_updates", group.getGroup());
        assertTrue((group.flags & Notification.FLAG_GROUP_SUMMARY) != 0);
        assertEquals(Notification.GROUP_ALERT_CHILDREN, group.getGroupAlertBehavior());
        assertEquals(2, group.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES).length);
        for (StatusBarNotification child : reminderChildren()) {
            if (child.getTag().endsWith(A) || child.getTag().endsWith(B)) {
                assertEquals(group.getGroup(), child.getNotification().getGroup());
                assertEquals(Notification.GROUP_ALERT_CHILDREN, child.getNotification().getGroupAlertBehavior());
            }
        }
    }
    @Test public void ownDismissAndLastRemovalRetireSummaryButPreserveReplayReceipt() {
        receiver().onMessageReceived(message(data(A), "first"));
        receiver().onMessageReceived(message(data(B), "second"));
        for (String id : new String[]{A, B}) {
            Notification child = java.util.Arrays.stream(reminderChildren()).filter(n -> n.getTag().endsWith(id))
                .findFirst().get().getNotification();
            Intent deleted = shadowOf(child.deleteIntent).getSavedIntent();
            new ReminderNotificationDismissReceiver().onReceive(context, deleted);
        }
        assertEquals(0, reminderChildren().length);
        assertNull(summary("eliza_updates"));
        assertTrue(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).getLong(A, 0) > 0);
        receiver().onMessageReceived(message(data(A), "replay"));
        assertEquals(0, manager.getActiveNotifications().length);
    }
    @Test public void canonicalChatTapRetiresChildOnlyWithOriginalTokenAndUri() {
        Map<String, String> current = data(A); current.put("deepLink", "/chat"); current.put("conversationId", B); current.put("messageId", A);
        receiver().onMessageReceived(message(current, "chat-tap"));
        Intent tap = shadowOf(reminderChildren()[0].getNotification().contentIntent).getSavedIntent();
        assertEquals(Intent.ACTION_VIEW, tap.getAction());
        Intent spoof = new Intent(tap);
        spoof.removeExtra("elizaReminderTapToken");
        ElizaReminderMessagingService.onReminderOpened(context, spoof);
        assertEquals(1, reminderChildren().length);
        Intent wrongUri = new Intent(tap).setData(tap.getData().buildUpon().appendQueryParameter("voice", "1").build());
        ElizaReminderMessagingService.onReminderOpened(context, wrongUri);
        assertEquals(1, reminderChildren().length);
        DeepLinkBufferPlugin.captureIntent(context, tap);
        ElizaReminderMessagingService.onReminderOpened(context, tap);
        assertEquals(0, reminderChildren().length);
        assertNull(summary("eliza_updates"));
        assertEquals(tap.getData().toString(), context.getSharedPreferences("eliza_deep_link_buffer", Context.MODE_PRIVATE).getString("pending_url", null));
    }
    @Test public void deferredPostAndCancellationSnapshotsDoNotLosePeersOrResurrectSummary() {
        receiver().onMessageReceived(message(data(A), "pending-first"));
        Notification first = reminderChildren()[0].getNotification();
        // Control a snapshot gap using the existing framework fake; no delete callback.
        // The accepted post is still in the native transient pending overlay.
        manager.cancelAll();
        receiver().onMessageReceived(message(data(B), "pending-second"));
        Notification second = reminderChildren()[0].getNotification();
        assertEquals(2, summary("eliza_updates").extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES).length);
        manager.notify("eliza.reminder:" + A, 0, first); // NMS exposes prior accepted child.
        new ReminderNotificationDismissReceiver().onReceive(context, shadowOf(first.deleteIntent).getSavedIntent());
        manager.notify("eliza.reminder:" + A, 0, first); // Report stale cancel-pending snapshot.
        new ReminderNotificationDismissReceiver().onReceive(context, shadowOf(second.deleteIntent).getSavedIntent());
        assertNull(summary("eliza_updates")); // Retired private token prevents resurrection.
        manager.cancel("eliza.reminder:" + A, 0); // NMS finishes queued cancellation.
        assertEquals(0, manager.getActiveNotifications().length);
    }
    @Test public void summaryLaunchIsGeneralAndDismissesOnlyItsOwnGroup() {
        receiver().onMessageReceived(message(data(A), "summary-first"));
        Notification grouped = summary("eliza_updates");
        Intent open = shadowOf(grouped.contentIntent).getSavedIntent();
        assertFalse(open.hasExtra("notificationId")); assertFalse(open.hasExtra("deepLink"));
        assertFalse((grouped.flags & Notification.FLAG_AUTO_CANCEL) != 0);
        Map<String, String> high = data(B); high.put("priority", "high");
        receiver().onMessageReceived(message(high, "other-channel"));
        new ReminderNotificationDismissReceiver().onReceive(context, shadowOf(grouped.deleteIntent).getSavedIntent());
        assertNull(summary("eliza_updates"));
        assertNotNull(summary("eliza_notifications"));
        assertEquals(1, reminderChildren().length);
    }
    @Test public void tokenPruningRetainsAcceptedChildrenButRemovesExpiredOrCorruptNamespaces() {
        receiver().onMessageReceived(message(data(A), "accepted"));
        android.content.SharedPreferences prefs = context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE);
        String token = prefs.getString("tap:" + A, null);
        String expired = "33333333-3333-4333-8333-333333333333";
        prefs.edit().putLong(expired, 1L).putString("tap:" + expired, B).putString("tap:bad", A).putLong("tap:" + B, 1L).putString("corrupt", "bad").commit();
        receiver().onMessageReceived(message(data(B), "fresh"));
        assertEquals(token, prefs.getString("tap:" + A, null));
        assertFalse(prefs.contains(expired)); assertFalse(prefs.contains("tap:" + expired)); assertFalse(prefs.contains("tap:bad")); assertFalse(prefs.contains("corrupt"));
    }
    @Test public void declaredBackendGroupReplacesOnlyItsPriorCanonicalChildAndExactTap() {
        Map<String, String> first = data(A); first.put("groupKey", "reminder:occurrence:owned");
        receiver().onMessageReceived(message(first, "first-grouped"));
        Map<String, String> next = data(B); next.put("groupKey", "reminder:occurrence:owned"); next.put("deepLink", "/chat"); next.put("messageId", B); next.put("conversationId", A); next.put("body", "Newest reminder body");
        assertTrue(ElizaReminderMessagingService.projectReminder(context, next, "foreground-newest"));
        assertEquals(1, reminderChildren().length);
        assertEquals("eliza.reminder:" + B, reminderChildren()[0].getTag());
        Intent tap = shadowOf(reminderChildren()[0].getNotification().contentIntent).getSavedIntent();
        assertEquals(B, tap.getStringExtra("notificationId")); assertEquals(B, tap.getData().getQueryParameter("messageId"));
        android.content.SharedPreferences prefs = context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE);
        assertTrue(prefs.getLong(A, 0) > 0); assertFalse(prefs.contains("tap:" + A));
        receiver().onMessageReceived(message(first, "old-group-replay"));
        assertEquals("eliza.reminder:" + B, reminderChildren()[0].getTag());
    }
    @Test public void distinctBackendGroupsDoNotCoalesceAndInvalidKeysAreRejected() {
        Map<String, String> first = data(A); first.put("groupKey", "first");
        Map<String, String> second = data(B); second.put("groupKey", "second");
        receiver().onMessageReceived(message(first, "first")); receiver().onMessageReceived(message(second, "second"));
        assertEquals(2, reminderChildren().length);
        for (String invalid : new String[]{"", "bad\nkey", new String(new char[513]).replace('\0', 'x')}) {
            Map<String, String> rejected = data("33333333-3333-4333-8333-333333333333"); rejected.put("groupKey", invalid);
            assertFalse(ElizaReminderMessagingService.projectReminder(context, rejected, "rejected"));
        }
        assertEquals(2, reminderChildren().length);
    }
    @Test public void mutedLegacyChoiceCreatesNeitherChildNorSummary() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Muted", NotificationManager.IMPORTANCE_NONE));
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        assertFalse(ElizaReminderMessagingService.projectReminder(context, occurrence, "muted"));
        assertEquals(0, manager.getActiveNotifications().length);
    }
    @Test public void foregroundAndFcmShareCanonicalIdentityAndReceipt() {
        Map<String, String> occurrence = data(A); occurrence.put("priority", "high"); occurrence.put("ownerType", "occurrence");
        assertTrue(ElizaReminderMessagingService.projectReminder(context, occurrence, "foreground"));
        receiver().onMessageReceived(message(occurrence, "fcm-replay"));
        assertEquals(1, reminderChildren().length);
        assertNotNull(summary("eliza_notifications"));
        assertEquals(2, manager.getActiveNotifications().length);
    }
    @Test public void malformedRequiredFieldsNeverProject() {
        for (String field : new String[]{"notificationId", "title", "body", "priority", "category"}) {
            Map<String, String> malformed = data(A); malformed.remove(field);
            receiver().onMessageReceived(message(malformed, field));
        }
        for (String field : new String[]{"notificationId", "title", "priority", "category"}) {
            Map<String, String> malformed = data(A); malformed.put(field, "");
            receiver().onMessageReceived(message(malformed, field));
        }
        assertEquals(0, reminderChildren().length);
    }
    @Test public void payloadCannotSelectExternalIntentComponentsOrActions() {
        Map<String, String> data = data(A);
        data.put("deepLink", "https://example.invalid/route");
        data.put("component", "malicious.external.Activity");
        data.put("action", Intent.ACTION_VIEW);
        receiver().onMessageReceived(message(data, "safe-app-tap"));
        Intent tap = shadowOf(reminderChildren()[0].getNotification().contentIntent).getSavedIntent();
        assertEquals(context.getPackageName(), tap.getComponent().getPackageName());
        assertNotEquals(Intent.ACTION_VIEW, tap.getAction());
        assertNull(tap.getData());
        assertEquals("https://example.invalid/route", tap.getStringExtra("deepLink"));
    }
    @Test public void nonReminderDataAndTokenRegistrationKeepStockReceiverBehavior() throws Exception {
        Map<String, String> legacy = new HashMap<>(); legacy.put("kind", "intent.session.start");
        RemoteMessage message = message(legacy, "generic-data");
        receiver().onMessageReceived(message);
        assertEquals(0, reminderChildren().length);
        assertSame(message, PushNotificationsPlugin.lastMessage);
        assertEquals(MessagingService.class, ElizaReminderMessagingService.class.getMethod("onNewToken", String.class).getDeclaringClass());
    }
    @Test public void capabilityRequiresTheDeclaredEnabledAppOwnedHandler() {
        Intent intent = new Intent("com.google.firebase.MESSAGING_EVENT").setPackage(context.getPackageName());
        ResolveInfo stock = new ResolveInfo(); stock.serviceInfo = new ServiceInfo();
        stock.serviceInfo.packageName = context.getPackageName(); stock.serviceInfo.enabled = true;
        stock.serviceInfo.name = MessagingService.class.getName();
        shadowOf(context.getPackageManager()).addResolveInfoForIntent(intent, stock);
        assertFalse(ElizaReminderMessagingService.isDeclaredHandler(context));
        stock.serviceInfo.name = ElizaReminderMessagingService.class.getName();
        assertTrue(ElizaReminderMessagingService.isDeclaredHandler(context));
        stock.serviceInfo.enabled = false;
        assertFalse(ElizaReminderMessagingService.isDeclaredHandler(context));
    }
}
