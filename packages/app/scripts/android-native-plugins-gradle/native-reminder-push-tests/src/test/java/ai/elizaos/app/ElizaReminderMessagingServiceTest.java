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
@Config(sdk = 35, application = android.app.Application.class)
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
        StatusBarNotification[] delivered = manager.getActiveNotifications();
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
        assertEquals(0, manager.getActiveNotifications().length);
        assertTrue(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).getLong(A, 0) > 0);
    }
    @Test public void receiptsCoverTheEntireFcmLifetimeThenExpire() {
        receiver().onMessageReceived(message(data(A), "first"));
        manager.cancelAll();
        context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).edit()
            .putLong(A, System.currentTimeMillis() - TimeUnit.DAYS.toMillis(28) + 60_000).commit();
        receiver().onMessageReceived(message(data(A), "still-live"));
        assertEquals(0, manager.getActiveNotifications().length);
        context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).edit()
            .putLong(A, System.currentTimeMillis() - TimeUnit.DAYS.toMillis(28) - 1).commit();
        receiver().onMessageReceived(message(data(A), "new-after-retention"));
        assertEquals(1, manager.getActiveNotifications().length);
    }
    @Test public void expiredReceiptsArePrunedWithoutARandomCountEviction() {
        long now = System.currentTimeMillis();
        android.content.SharedPreferences prefs = context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE);
        android.content.SharedPreferences.Editor edit = prefs.edit();
        for (int i = 0; i < 300; i++) edit.putLong(java.util.UUID.randomUUID().toString(), now - TimeUnit.DAYS.toMillis(28) - 1);
        edit.putLong(B, now);
        edit.commit();
        receiver().onMessageReceived(message(data(A), "current"));
        assertEquals(2, prefs.getAll().size());
        assertTrue(prefs.contains(B));
        assertTrue(prefs.contains(A));
    }
    @Test public void foregroundProcessUsesTheSameProjectionAndDeduplication() {
        Robolectric.buildActivity(Activity.class).setup();
        ElizaReminderMessagingService service = receiver();
        service.onMessageReceived(message(data(A), "google-first"));
        service.onMessageReceived(message(data(A), "google-repeat"));
        assertEquals(1, manager.getActiveNotifications().length);
        assertTrue((manager.getActiveNotifications()[0].getNotification().flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0);
    }
    @Test public void coldChatTapSurvivesBridgeReplacementThroughTheExistingUrlBuffer() {
        Map<String, String> data = data(A); data.put("deepLink", "/chat");
        data.put("conversationId", B); data.put("messageId", A);
        data.put("voice", "1"); data.put("action", "send");
        receiver().onMessageReceived(message(data, "cold-launch"));
        Intent tap = shadowOf(manager.getActiveNotifications()[0].getNotification().contentIntent).getSavedIntent();
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
    @Test public void deniedNotificationPermissionDoesNotPostOrConsumeReceipt() {
        shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.POST_NOTIFICATIONS);
        receiver().onMessageReceived(message(data(A), "denied"));
        assertEquals(0, manager.getActiveNotifications().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        receiver().onMessageReceived(message(data(A), "granted"));
        assertEquals(1, manager.getActiveNotifications().length);
    }
    @Test public void channelsPreserveSystemDndPolicy() {
        Map<String, String> data = data(A); data.put("priority", "urgent");
        receiver().onMessageReceived(message(data, "urgent"));
        assertEquals(5, manager.getNotificationChannel("eliza_alerts").getImportance());
        assertFalse(manager.getNotificationChannel("eliza_alerts").canBypassDnd());
    }
    @Test public void normalCalendarReminderKeepsDefaultTier() {
        receiver().onMessageReceived(message(data(A), "normal-calendar"));
        assertEquals("eliza_updates", manager.getActiveNotifications()[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel("eliza_updates").getImportance());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test public void highOccurrenceReminderUsesExistingHeadsUpTierWithoutBypassingDnd() {
        Map<String, String> high = data(A); high.put("priority", "high");
        receiver().onMessageReceived(message(high, "high-alert"));
        NotificationChannel channel = manager.getNotificationChannel("eliza_notifications");
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.getImportance());
        assertFalse(channel.canBypassDnd());
    }
    @Test public void explicitLowReminderStaysQuiet() {
        Map<String, String> quiet = data(A); quiet.put("priority", "low");
        receiver().onMessageReceived(message(quiet, "quiet"));
        assertEquals("eliza_quiet", manager.getActiveNotifications()[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("eliza_quiet").getImportance());
    }
    @Test public void existingQuietUpdatesChoiceIsPreserved() {
        manager.createNotificationChannel(new NotificationChannel("eliza_updates", "Quiet", NotificationManager.IMPORTANCE_LOW));
        receiver().onMessageReceived(message(data(A), "user-quiet"));
        assertEquals("eliza_updates", manager.getActiveNotifications()[0].getNotification().getChannelId());
        assertNull(manager.getNotificationChannel("eliza_notifications"));
    }
    @Test @Config(sdk = {26, 29}) public void legacyDefaultImportanceCustomSoundIsPreserved() {
        NotificationChannel updates = new NotificationChannel("eliza_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT);
        android.net.Uri sound = android.net.Uri.parse("content://media/internal/audio/media/42");
        updates.setSound(sound, new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION).build());
        manager.createNotificationChannel(updates);
        receiver().onMessageReceived(message(data(A), "legacy-sound"));
        assertEquals("eliza_updates", manager.getActiveNotifications()[0].getNotification().getChannelId());
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
        assertEquals(0, manager.getActiveNotifications().length);
        assertFalse(context.getSharedPreferences("eliza_reminder_push_receipts", Context.MODE_PRIVATE).contains(A));
    }
    @Test public void existingQuietHighTierIsPreservedForOccurrenceAlerts() {
        manager.createNotificationChannel(new NotificationChannel("eliza_notifications", "Quiet", NotificationManager.IMPORTANCE_LOW));
        Map<String, String> high = data(A); high.put("priority", "high");
        receiver().onMessageReceived(message(high, "quiet-high"));
        assertEquals("eliza_notifications", manager.getActiveNotifications()[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("eliza_notifications").getImportance());
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
        assertEquals(0, manager.getActiveNotifications().length);
    }
    @Test public void payloadCannotSelectExternalIntentComponentsOrActions() {
        Map<String, String> data = data(A);
        data.put("deepLink", "https://example.invalid/route");
        data.put("component", "malicious.external.Activity");
        data.put("action", Intent.ACTION_VIEW);
        receiver().onMessageReceived(message(data, "safe-app-tap"));
        Intent tap = shadowOf(manager.getActiveNotifications()[0].getNotification().contentIntent).getSavedIntent();
        assertEquals(context.getPackageName(), tap.getComponent().getPackageName());
        assertNotEquals(Intent.ACTION_VIEW, tap.getAction());
        assertNull(tap.getData());
        assertEquals("https://example.invalid/route", tap.getStringExtra("deepLink"));
    }
    @Test public void nonReminderDataAndTokenRegistrationKeepStockReceiverBehavior() throws Exception {
        Map<String, String> legacy = new HashMap<>(); legacy.put("kind", "intent.session.start");
        RemoteMessage message = message(legacy, "generic-data");
        receiver().onMessageReceived(message);
        assertEquals(0, manager.getActiveNotifications().length);
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
