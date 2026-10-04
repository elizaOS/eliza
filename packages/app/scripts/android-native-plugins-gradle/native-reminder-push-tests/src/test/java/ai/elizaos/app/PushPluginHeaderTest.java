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
@Config(sdk = 35)
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
        assertEquals(SafePushNotificationsPlugin.class,
            activity.getBridge().getPlugin("PushNotifications").getPluginClass());
    }
    @Test public void initialPluginWinsDiscoveryBeforeHeaderAndKeepsStockMethods() {
        InitialActivity activity = Robolectric.buildActivity(InitialActivity.class).create().get();
        assertEquals(SafePushNotificationsPlugin.class,
            activity.getBridge().getPlugin("PushNotifications").getPluginClass());
        assertTrue(activity.initialHeader.contains("getReminderDataCapabilities"));
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
}
