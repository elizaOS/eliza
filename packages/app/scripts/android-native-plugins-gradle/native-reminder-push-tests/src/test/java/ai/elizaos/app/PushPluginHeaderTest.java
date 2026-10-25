package ai.elizaos.app;

import static org.junit.Assert.*;

import android.os.Bundle;
import android.content.Intent;
import android.content.pm.PackageInfo;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSExport;
import com.getcapacitor.Plugin;
import java.util.List;
import org.junit.Test;
import org.junit.Before;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowWebView;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 29, 36})
public class PushPluginHeaderTest {
    @Before public void availableWebView() {
        PackageInfo info = new PackageInfo();
        info.packageName = "com.android.webview";
        info.versionName = "140.0.0.0";
        ShadowWebView.setCurrentWebViewPackage(info);
    }
    public static class LateActivity extends BridgeActivity {
        String initialHeader;
        @Override protected void onCreate(Bundle state) {
            config = new CapConfig.Builder(this).setResolveServiceWorkerRequests(false).create();
            super.onCreate(state);
            getBridge().registerPlugin(SafePushNotificationsPlugin.class);
        }
        @Override protected void load() {
            super.load();
            initialHeader = JSExport.getPluginJS(List.of(getBridge().getPlugin("PushNotifications")));
        }
    }
    public static class InitialActivity extends BridgeActivity {
        String initialHeader;
        @Override protected void onCreate(Bundle state) {
            config = new CapConfig.Builder(this).setResolveServiceWorkerRequests(false).create();
            initialPlugins.add(SafePushNotificationsPlugin.class);
            super.onCreate(state);
        }
        @Override protected void load() {
            super.load();
            initialHeader = JSExport.getPluginJS(List.of(getBridge().getPlugin("PushNotifications")));
        }
    }
    @Test public void lateReplacementDoesNotExportCapabilityToInitialRenderer() {
        LateActivity activity = Robolectric.buildActivity(LateActivity.class).create().get();
        assertFalse(activity.initialHeader.contains("getReminderDataCapabilities"));
        assertFalse(activity.initialHeader.contains("resolveReminderChannel"));
        assertFalse(activity.initialHeader.contains("presentReminderNotification"));
        assertEquals(SafePushNotificationsPlugin.class,
            activity.getBridge().getPlugin("PushNotifications").getPluginClass());
    }
    @Test public void initialPluginWinsDiscoveryBeforeHeaderAndKeepsStockMethods() {
        InitialActivity activity = Robolectric.buildActivity(InitialActivity.class).create().get();
        assertEquals(SafePushNotificationsPlugin.class,
            activity.getBridge().getPlugin("PushNotifications").getPluginClass());
        assertTrue(activity.initialHeader.contains("getReminderDataCapabilities"));
        assertTrue(activity.initialHeader.contains("resolveReminderChannel"));
        assertTrue(activity.initialHeader.contains("presentReminderNotification"));
        assertTrue(activity.initialHeader.contains("checkPermissions"));
        assertTrue(activity.initialHeader.contains("register"));
        assertTrue(activity.initialHeader.contains("addListener"));
    }
    @Test public void initialPluginRetainsOneColdTapForTheLaterJsListener() throws Exception {
        Intent tap = new Intent().putExtra("google.message_id", "cold-fcm")
            .putExtra("notificationId", "11111111-1111-4111-8111-111111111111")
            .putExtra("deepLink", "/chat");
        InitialActivity activity = Robolectric.buildActivity(InitialActivity.class, tap).create().get();
        java.lang.reflect.Field field = Plugin.class.getDeclaredField("retainedEventArguments");
        field.setAccessible(true);
        java.util.Map<?, ?> events = (java.util.Map<?, ?>) field.get(
            activity.getBridge().getPlugin("PushNotifications").getInstance());
        List<?> taps = (List<?>) events.get("pushNotificationActionPerformed");
        assertNotNull(taps);
        assertEquals(1, taps.size());
        assertTrue(taps.get(0).toString().contains("11111111-1111-4111-8111-111111111111"));
    }
    private static class ChannelCall extends com.getcapacitor.PluginCall {
        com.getcapacitor.JSObject result;
        ChannelCall(com.getcapacitor.JSObject request) {
            super(null, "PushNotifications", "channel-test", "resolveReminderChannel", request);
        }
        @Override public void resolve(com.getcapacitor.JSObject result) { this.result = result; }
        @Override public void reject(String message) { throw new AssertionError(message); }
    }
    @Config(sdk = {29, 36})
    @Test public void foregroundSelectorPreservesGroupAndReportsBlockedState() throws Exception {
        InitialActivity activity = Robolectric.buildActivity(InitialActivity.class).create().get();
        android.app.NotificationManager manager = activity.getSystemService(android.app.NotificationManager.class);
        android.app.NotificationChannelGroup group = new android.app.NotificationChannelGroup("muted-reminders", "Muted reminders");
        org.robolectric.util.ReflectionHelpers.setField(group, "mBlocked", true);
        manager.createNotificationChannelGroup(group);
        android.app.NotificationChannel updates = new android.app.NotificationChannel("eliza_updates", "Updates", android.app.NotificationManager.IMPORTANCE_DEFAULT);
        updates.setGroup("muted-reminders");
        updates.setLockscreenVisibility(android.app.Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(updates);
        SafePushNotificationsPlugin plugin = (SafePushNotificationsPlugin) activity.getBridge().getPlugin("PushNotifications").getInstance();
        com.getcapacitor.JSObject request = new com.getcapacitor.JSObject();
        request.put("priority", "high"); request.put("ownerType", "occurrence");
        ChannelCall blocked = new ChannelCall(request);
        plugin.resolveReminderChannel(blocked);
        assertEquals("eliza_updates", blocked.result.getString("channelId"));
        assertTrue(blocked.result.getBoolean("blocked"));
        org.robolectric.util.ReflectionHelpers.setField(group, "mBlocked", false);
        manager.createNotificationChannelGroup(group);
        ChannelCall unblocked = new ChannelCall(request);
        plugin.resolveReminderChannel(unblocked);
        assertEquals("eliza_updates", unblocked.result.getString("channelId"));
        assertFalse(unblocked.result.getBoolean("blocked"));
        assertEquals(android.app.Notification.VISIBILITY_SECRET, manager.getNotificationChannel("eliza_updates").getLockscreenVisibility());
    }
}
