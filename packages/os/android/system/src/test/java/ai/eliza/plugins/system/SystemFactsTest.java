package ai.eliza.plugins.system;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Host-JVM checks of system facts, settings handoffs and shade outcomes (see settings.test.mjs). */
public final class SystemFactsTest {
    static void check(boolean ok, String why) { if (!ok) throw new AssertionError(why); }

    public static void main(String[] args) {
        mappings();
        facts();
        pages();
        shade();
        System.out.println("PASS system facts, settings handoffs and shade outcomes");
    }

    static void mappings() {
        check(SystemFacts.wifiSwitch(0) == Boolean.FALSE && SystemFacts.wifiSwitch(3) == Boolean.FALSE, "wifi off");
        check(SystemFacts.wifiSwitch(1) == Boolean.TRUE && SystemFacts.wifiSwitch(2) == Boolean.TRUE, "wifi on, also in airplane mode");
        check(SystemFacts.wifiSwitch(4) == null && SystemFacts.wifiSwitch(-1) == null, "unknown wifi");
        check(SystemFacts.binarySwitch(0) == Boolean.FALSE && SystemFacts.binarySwitch(1) == Boolean.TRUE, "binary");
        check(SystemFacts.binarySwitch(2) == null && SystemFacts.binarySwitch(-1) == null, "unknown binary");
        check(SystemFacts.adapterSwitch(android.bluetooth.BluetoothAdapter.STATE_ON) == Boolean.TRUE, "adapter on");
        check(SystemFacts.adapterSwitch(android.bluetooth.BluetoothAdapter.STATE_OFF) == Boolean.FALSE, "adapter off");
        check(SystemFacts.adapterSwitch(android.bluetooth.BluetoothAdapter.STATE_TURNING_ON) == null
                && SystemFacts.adapterSwitch(android.bluetooth.BluetoothAdapter.STATE_TURNING_OFF) == null, "transitions are unknown");
        check("all".equals(SystemFacts.interruptionName(android.app.NotificationManager.INTERRUPTION_FILTER_ALL)), "all");
        check("priority".equals(SystemFacts.interruptionName(android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY)), "priority");
        check("alarms".equals(SystemFacts.interruptionName(android.app.NotificationManager.INTERRUPTION_FILTER_ALARMS)), "alarms");
        check("none".equals(SystemFacts.interruptionName(android.app.NotificationManager.INTERRUPTION_FILTER_NONE)), "none");
        check(SystemFacts.interruptionName(0) == null && SystemFacts.interruptionName(99) == null, "unknown filter");
    }

    static void facts() {
        android.content.Context context = new android.content.Context();
        Map<String, Object> all = SystemFacts.read(context);
        check(all.equals(Map.ofEntries(
                Map.entry("wifiEnabled", true), Map.entry("bluetoothEnabled", true), Map.entry("airplaneMode", false),
                Map.entry("locationEnabled", true), Map.entry("mobileDataEnabled", true), Map.entry("interruptionFilter", "priority"),
                Map.entry("adaptiveBrightness", true), Map.entry("wifiActive", true), Map.entry("cellularActive", false),
                Map.entry("internetValidated", true), Map.entry("batteryPercent", 57), Map.entry("charging", true), Map.entry("powerSave", false))), "every answered fact: " + all);

        // Before Android 12 the stored switch is read; a transition reads as unknown.
        android.os.Build.VERSION.SDK_INT = 30;
        android.provider.Settings.Global.values.put("bluetooth_on", 0);
        check(Boolean.FALSE.equals(SystemFacts.read(context).get("bluetoothEnabled")), "stored switch before S");
        android.os.Build.VERSION.SDK_INT = 36;
        context.adapterState = android.bluetooth.BluetoothAdapter.STATE_TURNING_ON;
        check(!SystemFacts.read(context).containsKey("bluetoothEnabled"), "turning on is unknown");

        // Nothing answers: every fact is omitted, none is reported as off.
        android.provider.Settings.Global.values.clear();
        android.provider.Settings.System.values.clear();
        context.services.clear();
        context.telephony = false;
        context.batteryFails = true;
        check(SystemFacts.read(context).isEmpty(), "unknown everywhere: " + SystemFacts.read(context));
        android.provider.Settings.Global.values.put("wifi_on", 1);

        // Mobile data needs telephony, a ready SIM, the install-time network-state grant and an answer.
        android.content.Context data = new android.content.Context();
        data.simState = 1;
        check(!SystemFacts.read(data).containsKey("mobileDataEnabled"), "no SIM is unknown");
        data.simState = android.telephony.TelephonyManager.SIM_STATE_READY;
        data.networkStateGranted = false;
        check(!SystemFacts.read(data).containsKey("mobileDataEnabled"), "no grant is unknown");
        data.networkStateGranted = true;
        data.dataRefused = true;
        check(!SystemFacts.read(data).containsKey("mobileDataEnabled"), "refusal is unknown");
        // No active network is a fact about transport only.
        data.network = false;
        Map<String, Object> offline = SystemFacts.read(data);
        check(Boolean.FALSE.equals(offline.get("wifiActive")) && Boolean.TRUE.equals(offline.get("wifiEnabled")), "disconnected Wi-Fi stays on");
    }

    static void pages() {
        for (String page : SystemSettingsPages.PAGES) check(SystemSettingsPages.actions(page) != null && SystemSettingsPages.actions(page).length > 0, page);
        for (String unknown : new String[] {null, "", "wallet", "WIFI", "../wifi", "factory-reset"}) {
            check(SystemSettingsPages.actions(unknown) == null, "not allowlisted " + unknown);
            try { SystemSettingsPages.open(unknown, "example.host", intent -> {}); throw new AssertionError("opened " + unknown); }
            catch (IllegalArgumentException expected) { /* refused */ }
        }
        List<android.content.Intent> started = new ArrayList<>();
        check(SystemSettingsPages.open("wifi", "example.host", started::add) == 0 && started.get(0).action.equals(android.provider.Settings.ACTION_WIFI_SETTINGS), "specific page");
        started.clear();
        int opened = SystemSettingsPages.open("airplane", "example.host", intent -> {
            if (intent.action.equals(android.provider.Settings.ACTION_AIRPLANE_MODE_SETTINGS)) throw new RuntimeException("absent on this image");
            started.add(intent);
        });
        check(opened == 1 && started.get(0).action.equals(android.provider.Settings.ACTION_WIRELESS_SETTINGS), "broader fallback is reported");
        check(SystemSettingsPages.open("dnd", "example.host", intent -> { throw new RuntimeException("none"); }) == -1, "nothing opened");
        started.clear();
        SystemSettingsPages.open("privacy", "example.host", started::add);
        check("package:example.host".equals(String.valueOf(started.get(0).data)), "per-app details page carries this package only");
        started.clear();
        SystemSettingsPages.open("notifications", "example.host", started::add);
        check("example.host".equals(started.get(0).extras.get(android.provider.Settings.EXTRA_APP_PACKAGE)), "per-app notification page");
    }

    static final class Bar { int calls; public void expandNotificationsPanel() { calls++; } }
    static final class RefusingBar { public void expandNotificationsPanel() { throw new SecurityException("refused"); } }

    static SystemShade.Platform platform(boolean granted, Object service) {
        return new SystemShade.Platform() {
            @Override public boolean granted(String permission) { return granted && SystemShade.PERMISSION.equals(permission); }
            @Override public Object statusBar() { return service; }
        };
    }

    static void shade() {
        Bar bar = new Bar();
        check(SystemShade.STANDALONE.equals(SystemShade.expand(platform(true, bar), false)), "a non-launcher never asks");
        check(SystemShade.PERMISSION_MISSING.equals(SystemShade.expand(platform(false, bar), true)), "permission missing");
        check(SystemShade.UNSUPPORTED.equals(SystemShade.expand(platform(true, null), true)), "no service");
        check(SystemShade.UNSUPPORTED.equals(SystemShade.expand(platform(true, new Object()), true)), "no method");
        check(SystemShade.UNSUPPORTED.equals(SystemShade.expand(platform(true, new RefusingBar()), true)), "refused");
        check(bar.calls == 0, "nothing asked before admission");
        check(SystemShade.OPENED.equals(SystemShade.expand(platform(true, bar), true)) && bar.calls == 1, "accepted once");
        SystemShade.Platform throwing = new SystemShade.Platform() {
            @Override public boolean granted(String permission) { return true; }
            @Override public Object statusBar() { throw new IllegalStateException("service lookup"); }
        };
        check(SystemShade.UNSUPPORTED.equals(SystemShade.expand(throwing, true)), "lookup failure");
    }
}
