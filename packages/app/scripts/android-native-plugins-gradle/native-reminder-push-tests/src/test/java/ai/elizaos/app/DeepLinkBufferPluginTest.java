package ai.elizaos.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSExport;
import com.getcapacitor.PluginCall;
import com.getcapacitor.Plugin;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONArray;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowWebView;

/** Production capture and bridge methods under Android's host framework. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 29, 36})
public class DeepLinkBufferPluginTest {
    public static class ReceiptActivity extends BridgeActivity {
        private Intent initialDeepLinkIntent;
        String initialReceipt;
        @Override protected void onCreate(Bundle state) {
            config = new CapConfig.Builder(this).setResolveServiceWorkerRequests(false).create();
            initialPlugins.add(DeepLinkBufferPlugin.class);
            initialDeepLinkIntent = getIntent();
            DeepLinkBufferPlugin.captureIntent(this, initialDeepLinkIntent);
            initialReceipt = DeepLinkBufferPlugin.capturedReceipt(initialDeepLinkIntent);
            super.onCreate(state);
        }
        @Override protected void onNewIntent(Intent intent) {
            if (intent != initialDeepLinkIntent) DeepLinkBufferPlugin.captureIntent(this, intent);
            initialDeepLinkIntent = null;
            super.onNewIntent(intent);
        }
    }

    public static class LegacyActivity extends ReceiptActivity {
        @Override protected void load() {
            initialPlugins.clear();
            bridgeBuilder.setPlugins(java.util.List.of(
                DeepLinkBufferPlugin.class,
                com.capacitorjs.plugins.app.AppPlugin.class
            ));
            super.load();
        }
    }

    public static class CustomReceiptActivity extends BridgeActivity {
        Class<? extends Plugin> appClass;
        Class<? extends Plugin> bufferClass;

        @Override protected void onCreate(Bundle state) {
            config = new CapConfig.Builder(this).setResolveServiceWorkerRequests(false).create();
            try (var input = getAssets().open("receipt-custom.plugins.json")) {
                String contents = new java.util.Scanner(input, "UTF-8").useDelimiter("\\A").next();
                JSONArray manifest = new JSONArray(contents);
                appClass = Class.forName(manifest.getJSONObject(0).getString("classpath")).asSubclass(Plugin.class);
                bufferClass = Class.forName("ai.receipt.fixture.DeepLinkBufferPlugin").asSubclass(Plugin.class);
                var capture = bufferClass.getDeclaredMethod("captureIntent", Context.class, Intent.class);
                capture.setAccessible(true);
                capture.invoke(null, this, getIntent());
            } catch (Exception error) {
                throw new AssertionError(error);
            }
            super.onCreate(state);
        }

        @Override protected void load() {
            bridgeBuilder.setPlugins(java.util.List.of(bufferClass, appClass));
            super.load();
        }
    }

    private static class RecordedCall extends PluginCall {
        JSObject result;
        final java.util.List<JSObject> responses = new java.util.ArrayList<>();
        RecordedCall(JSObject request) {
            super(null, "DeepLinkBuffer", "receipt-test", "method", request);
        }
        @Override public void resolve() { resolve(new JSObject()); }
        @Override public void resolve(JSObject value) { result = value; responses.add(value); }
        @Override public void reject(String message) { throw new AssertionError(message); }
    }

    @Before public void setup() {
        PackageInfo info = new PackageInfo();
        info.packageName = "com.android.webview";
        info.versionName = "140.0.0.0";
        ShadowWebView.setCurrentWebViewPackage(info);
        RuntimeEnvironment.getApplication()
            .getSharedPreferences("eliza_deep_link_buffer", Context.MODE_PRIVATE)
            .edit().clear().commit();
    }

    private Intent intent() {
        return new Intent(Intent.ACTION_VIEW, Uri.parse("eliza://ask"));
    }

    private DeepLinkBufferPlugin plugin(ReceiptActivity activity) {
        return (DeepLinkBufferPlugin) activity.getBridge().getPlugin("DeepLinkBuffer").getInstance();
    }

    private ReceiptAppPlugin app(ReceiptActivity activity) {
        return (ReceiptAppPlugin) activity.getBridge().getPlugin("App").getInstance();
    }

    private RecordedCall listen(ReceiptActivity activity) {
        JSObject request = new JSObject();
        request.put("eventName", "appUrlOpen");
        RecordedCall listener = new RecordedCall(request);
        app(activity).addListener(listener);
        return listener;
    }

    private JSObject peek(DeepLinkBufferPlugin plugin) {
        RecordedCall call = new RecordedCall(new JSObject());
        plugin.peekPendingUrl(call);
        return call.result;
    }

    private boolean acknowledge(DeepLinkBufferPlugin plugin, String receipt) {
        JSObject request = new JSObject();
        request.put("url", "eliza://ask");
        if (receipt != null) request.put("receiptId", receipt);
        RecordedCall call = new RecordedCall(request);
        plugin.acknowledgePendingUrl(call);
        return call.result.getBoolean("cleared", null);
    }

    @Test public void sameUrlCaptureRequiresItsOwnReceipt() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class, intent()).create().get();
        DeepLinkBufferPlugin plugin = plugin(activity);
        JSObject first = peek(plugin);
        assertEquals(Integer.valueOf(2), first.getInteger("receiptVersion"));
        activity.onNewIntent(intent());
        JSObject second = peek(plugin);
        assertNotEquals(first.getString("receiptId"), second.getString("receiptId"));
        assertFalse(acknowledge(plugin, first.getString("receiptId")));
        assertEquals(second.getString("receiptId"), peek(plugin).getString("receiptId"));
        assertTrue(acknowledge(plugin, second.getString("receiptId")));
        assertTrue(peek(plugin).isNull("url"));
        assertTrue(peek(plugin).isNull("receiptId"));
    }

    @Test public void olderRendererCannotClearAnUnidentifiedCapture() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class, intent()).create().get();
        DeepLinkBufferPlugin plugin = plugin(activity);
        String receipt = peek(plugin).getString("receiptId");
        assertFalse(acknowledge(plugin, null));
        assertEquals(receipt, peek(plugin).getString("receiptId"));
    }

    @Test public void stockAppCompositionAdvertisesTheLegacyDeliveryContract() {
        LegacyActivity activity = Robolectric.buildActivity(LegacyActivity.class, intent()).create().get();
        assertEquals(Integer.valueOf(1), peek(plugin(activity)).getInteger("receiptVersion"));
        assertEquals(com.capacitorjs.plugins.app.AppPlugin.class,
            activity.getBridge().getPlugin("App").getPluginClass());
    }

    @Test public void legacyUrlGetsOneStablePersistedReceipt() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class).create().get();
        activity.getSharedPreferences("eliza_deep_link_buffer", Context.MODE_PRIVATE)
            .edit().putString("pending_url", "eliza://ask").commit();
        DeepLinkBufferPlugin plugin = plugin(activity);
        String receipt = peek(plugin).getString("receiptId");
        assertNotNull(receipt);
        assertEquals(receipt, peek(plugin).getString("receiptId"));
        assertTrue(acknowledge(plugin, receipt));
    }

    @Test public void warmEventsCarryEachCapturedIntentIdentity() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class).create().get();
        DeepLinkBufferPlugin plugin = plugin(activity);
        RecordedCall listener = listen(activity);
        activity.onNewIntent(intent());
        String first = peek(plugin).getString("receiptId");
        activity.onNewIntent(intent());
        String second = peek(plugin).getString("receiptId");
        assertEquals(2, listener.responses.size());
        assertEquals(first, listener.responses.get(0).getString("receiptId"));
        assertEquals(second, listener.responses.get(1).getString("receiptId"));
    }

    @Test public void warmCapturesBeforeListenerKeepTheirOwnReceipts() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class).create().get();
        DeepLinkBufferPlugin buffer = plugin(activity);
        activity.onNewIntent(intent());
        String first = peek(buffer).getString("receiptId");
        activity.onNewIntent(intent());
        String second = peek(buffer).getString("receiptId");
        RecordedCall listener = listen(activity);
        assertEquals(2, listener.responses.size());
        assertEquals(first, listener.responses.get(0).getString("receiptId"));
        assertEquals(second, listener.responses.get(1).getString("receiptId"));
        // A legacy listener reads the unchanged URL field from this same queue.
        assertEquals("eliza://ask", listener.responses.get(0).getString("url"));
        assertEquals("eliza://ask", listener.responses.get(1).getString("url"));
    }

    @Test public void coldInitialIntentMatchesOneRetainedAppEvent() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class, intent()).create().get();
        String receipt = peek(plugin(activity)).getString("receiptId");
        assertEquals(activity.initialReceipt, receipt);
        RecordedCall listener = listen(activity);
        assertEquals(1, listener.responses.size());
        assertEquals(receipt, listener.responses.get(0).getString("receiptId"));
        RecordedCall launch = new RecordedCall(new JSObject());
        app(activity).getLaunchUrl(launch);
        assertEquals("eliza://ask", launch.result.getString("url"));
    }

    @Test public void receiptProjectionWinsDiscoveryAndKeepsStockMethods() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class).create().get();
        assertEquals(ReceiptAppPlugin.class, activity.getBridge().getPlugin("App").getPluginClass());
        String header = JSExport.getPluginJS(java.util.List.of(activity.getBridge().getPlugin("App")));
        assertTrue(header.contains("getLaunchUrl"));
        assertTrue(header.contains("getState"));
        assertTrue(header.contains("minimizeApp"));
        assertTrue(header.contains("addListener"));
    }

    @Test public void disablingAppBackHandlerLeavesNoDiscardedStockCallback() {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class).setup().get();
        assertTrue(activity.getOnBackPressedDispatcher().hasEnabledCallbacks());
        JSObject request = new JSObject();
        request.put("enabled", false);
        app(activity).toggleBackButtonHandler(new RecordedCall(request));
        assertFalse(activity.getOnBackPressedDispatcher().hasEnabledCallbacks());
    }

    @Test public void generatedCustomPackageLoadsReceiptPluginFromItsManifest() throws Exception {
        CustomReceiptActivity activity = Robolectric.buildActivity(CustomReceiptActivity.class, intent()).create().get();
        var bridge = activity.getBridge();
        assertEquals("ai.receipt.fixture.ReceiptAppPlugin", bridge.getPlugin("App").getPluginClass().getName());
        Plugin buffer = bridge.getPlugin("DeepLinkBuffer").getInstance();
        RecordedCall peek = new RecordedCall(new JSObject());
        buffer.getClass().getMethod("peekPendingUrl", PluginCall.class).invoke(buffer, peek);
        assertEquals(Integer.valueOf(2), peek.result.getInteger("receiptVersion"));
        JSObject request = new JSObject();
        request.put("eventName", "appUrlOpen");
        RecordedCall listener = new RecordedCall(request);
        bridge.getPlugin("App").getInstance().addListener(listener);
        assertEquals(1, listener.responses.size());
        assertEquals(peek.result.getString("receiptId"), listener.responses.get(0).getString("receiptId"));
    }

    @Test public void failedDiskConfirmationStillReturnsTheVisibleReceipt() throws Exception {
        ReceiptActivity activity = Robolectric.buildActivity(ReceiptActivity.class).create().get();
        assertTrue(activity.getSharedPreferences("eliza_deep_link_buffer", Context.MODE_PRIVATE)
            .edit().putString("pending_url", "eliza://ask").commit());
        File directory = new File(activity.getApplicationInfo().dataDir, "shared_prefs");
        File backup = new File(activity.getApplicationInfo().dataDir, "shared_prefs-quint");
        assertTrue(directory.renameTo(backup));
        try {
            Files.write(directory.toPath(), "Block the actual preference disk write".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            DeepLinkBufferPlugin plugin = plugin(activity);
            String receipt = peek(plugin).getString("receiptId");
            assertNotNull(receipt);
            assertEquals(receipt, peek(plugin).getString("receiptId"));
            assertFalse(acknowledge(plugin, receipt));
            assertTrue(peek(plugin).isNull("url"));
        } finally {
            Files.deleteIfExists(directory.toPath());
            assertTrue(backup.renameTo(directory));
        }
    }
}
