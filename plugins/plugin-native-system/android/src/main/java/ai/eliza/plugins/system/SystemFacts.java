package ai.eliza.plugins.system;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * System switch, network and power facts an ordinary app may read without a permission it does
 * not hold. Each fact is added only when Android answers: a missing key means unknown, never off.
 * Read-only: nothing here changes a setting, so settings surfaces show these states and hand off
 * to Android's own pages ({@link SystemSettingsPages}).
 */
public final class SystemFacts {
    private SystemFacts() {}

    /** Settings.Global.WIFI_ON: 1 and 2 (kept on in airplane mode) are on, 0 and 3 off; else unknown. */
    public static Boolean wifiSwitch(int value) {
        return value == 1 || value == 2 ? Boolean.TRUE : value == 0 || value == 3 ? Boolean.FALSE : null;
    }

    /** A 0/1 system switch; any other stored value is unknown rather than guessed. */
    public static Boolean binarySwitch(int value) {
        return value == 1 ? Boolean.TRUE : value == 0 ? Boolean.FALSE : null;
    }

    /** BluetoothAdapter.getState(): only settled on and off are facts; turning on or off is unknown. */
    public static Boolean adapterSwitch(int state) {
        return state == android.bluetooth.BluetoothAdapter.STATE_ON ? Boolean.TRUE
                : state == android.bluetooth.BluetoothAdapter.STATE_OFF ? Boolean.FALSE : null;
    }

    /** NotificationManager interruption filter as a stable name; unknown filters are omitted. */
    public static String interruptionName(int filter) {
        return filter == NotificationManager.INTERRUPTION_FILTER_ALL ? "all"
                : filter == NotificationManager.INTERRUPTION_FILTER_PRIORITY ? "priority"
                : filter == NotificationManager.INTERRUPTION_FILTER_ALARMS ? "alarms"
                : filter == NotificationManager.INTERRUPTION_FILTER_NONE ? "none" : null;
    }

    /** A single read that may fail; failure or null omits the key. */
    public interface Fact {
        Object read() throws Exception;
    }

    public static void fact(Map<String, Object> out, String key, Fact source) {
        try {
            Object value = source.read();
            if (value != null) out.put(key, value);
        } catch (Exception unreadable) {
            // Omitted: settings surfaces show this setting as unknown.
        }
    }

    /**
     * {@code wifiEnabled}, {@code bluetoothEnabled}, {@code airplaneMode}, {@code locationEnabled},
     * {@code mobileDataEnabled}, {@code interruptionFilter}, {@code adaptiveBrightness}, the active
     * transport ({@code wifiActive}, {@code cellularActive}, {@code internetValidated}) and power
     * ({@code batteryPercent}, {@code charging}, {@code powerSave}), each only when Android answered.
     */
    public static Map<String, Object> read(Context context) {
        Map<String, Object> out = new LinkedHashMap<>();
        android.content.ContentResolver resolver = context.getContentResolver();
        fact(out, "wifiEnabled", () -> wifiSwitch(Settings.Global.getInt(resolver, Settings.Global.WIFI_ON)));
        // The adapter state is what the radio is doing now and needs no permission from Android 12.
        // The stored switch is the owner's last choice, which airplane mode can override, and is used
        // only on older releases, where the adapter read needs a permission an ordinary app lacks.
        fact(out, "bluetoothEnabled", () -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return binarySwitch(Settings.Global.getInt(resolver, Settings.Global.BLUETOOTH_ON));
            android.bluetooth.BluetoothManager manager = context.getSystemService(android.bluetooth.BluetoothManager.class);
            android.bluetooth.BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            return adapter == null ? null : adapterSwitch(adapter.getState());
        });
        fact(out, "airplaneMode", () -> binarySwitch(Settings.Global.getInt(resolver, Settings.Global.AIRPLANE_MODE_ON)));
        fact(out, "locationEnabled", () -> {
            android.location.LocationManager location = context.getSystemService(android.location.LocationManager.class);
            return location == null ? null : location.isLocationEnabled();
        });
        fact(out, "mobileDataEnabled", () -> {
            if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) return null;
            android.telephony.TelephonyManager telephony = context.getSystemService(android.telephony.TelephonyManager.class);
            if (telephony == null || telephony.getSimState() != android.telephony.TelephonyManager.SIM_STATE_READY) return null;
            // Readable with the install-time ACCESS_NETWORK_STATE permission; a refusal means unknown, never off.
            if (context.checkSelfPermission(android.Manifest.permission.ACCESS_NETWORK_STATE) != PackageManager.PERMISSION_GRANTED) return null;
            try {
                return telephony.isDataEnabled();
            } catch (SecurityException refused) {
                return null;
            }
        });
        fact(out, "interruptionFilter", () -> {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            return manager == null ? null : interruptionName(manager.getCurrentInterruptionFilter());
        });
        fact(out, "adaptiveBrightness", () -> {
            int mode = Settings.System.getInt(resolver, Settings.System.SCREEN_BRIGHTNESS_MODE);
            return mode == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC ? Boolean.TRUE
                    : mode == Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL ? Boolean.FALSE : null;
        });
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        if (connectivity != null) {
            // No active network is a fact (nothing connected); it never says a radio is off.
            fact(out, "wifiActive", () -> transport(connectivity, NetworkCapabilities.TRANSPORT_WIFI));
            fact(out, "cellularActive", () -> transport(connectivity, NetworkCapabilities.TRANSPORT_CELLULAR));
            fact(out, "internetValidated", () -> {
                NetworkCapabilities network = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
                return network != null && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            });
        }
        Intent battery = null;
        try {
            battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        } catch (RuntimeException unavailable) {
            // Battery facts stay unknown.
        }
        if (battery != null) {
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) out.put("batteryPercent", Math.max(0, Math.min(100, Math.round(level * 100f / scale))));
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            if (status != -1) out.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
        }
        fact(out, "powerSave", () -> {
            PowerManager power = context.getSystemService(PowerManager.class);
            return power == null ? null : power.isPowerSaveMode();
        });
        return out;
    }

    private static Boolean transport(ConnectivityManager connectivity, int transport) {
        NetworkCapabilities network = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        return network != null && network.hasTransport(transport);
    }
}
