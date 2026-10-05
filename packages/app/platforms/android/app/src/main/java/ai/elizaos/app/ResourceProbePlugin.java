package ai.elizaos.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Debug;
import android.os.PowerManager;
import android.system.Os;
import android.system.OsConstants;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * Capacitor plugin that surfaces a live device-resource snapshot to JS for the
 * Mobile Resource Workbench (issue #8800) — the Android parity of the iOS
 * {@code ElizaIntent.getResourceSnapshot}.
 *
 * <p>Reads:
 * <ul>
 *   <li><b>thermalState</b> — {@link PowerManager#getCurrentThermalStatus()}
 *       (API 29+), mapped to the shared {@code nominal/fair/serious/critical}
 *       model; {@code "unknown"} on older OSes.</li>
 *   <li><b>battery</b> — {@link BatteryManager} level (%), charge counter (µAh),
 *       instantaneous current (µA), and charging flag.</li>
 *   <li><b>memory</b> — {@link Debug#getMemoryInfo} total PSS (the app's real
 *       footprint) plus {@link ActivityManager.MemoryInfo} device available
 *       and total RAM (the latter feeds the renderer's RAM-tier gating,
 *       #14390).</li>
 *   <li><b>cpuTimeMs</b> — process user+system jiffies from {@code /proc/self/stat}
 *       converted via {@code sysconf(_SC_CLK_TCK)}.</li>
 *   <li><b>lowPowerMode</b> — {@link PowerManager#isPowerSaveMode()}.</li>
 * </ul>
 *
 * <p>Every value the OS cannot provide is returned as JSON {@code null}, never a
 * fabricated zero (AGENTS.md §3/§7).
 */
@CapacitorPlugin(name = "ResourceProbe")
public class ResourceProbePlugin extends Plugin {

    @PluginMethod
    public void getResourceSnapshot(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("platform", "android");

        result.put("thermalState", readThermalState(context));
        result.put("lowPowerMode", readPowerSaveMode(context));

        BatteryManager bm = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        result.put("batteryLevelPct", readBatteryProperty(bm, BatteryManager.BATTERY_PROPERTY_CAPACITY));
        result.put("batteryChargeMicroAmpHours",
            readBatteryProperty(bm, BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER));
        result.put("batteryCurrentMicroAmps",
            readBatteryProperty(bm, BatteryManager.BATTERY_PROPERTY_CURRENT_NOW));
        result.put("isCharging", bm != null && bm.isCharging());

        result.put("residentMemoryMb", readTotalPssMb());
        result.put("availableRamMb", readAvailableRamMb(context));
        result.put("totalRamMb", readTotalRamMb(context));
        result.put("cpuTimeMs", readProcessCpuTimeMs());

        result.put("capturedAtMs", System.currentTimeMillis());
        call.resolve(result);
    }

    private static String readThermalState(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return "unknown";
        }
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm == null) {
            return "unknown";
        }
        switch (pm.getCurrentThermalStatus()) {
            case PowerManager.THERMAL_STATUS_NONE:
                return "nominal";
            case PowerManager.THERMAL_STATUS_LIGHT:
            case PowerManager.THERMAL_STATUS_MODERATE:
                return "fair";
            case PowerManager.THERMAL_STATUS_SEVERE:
            case PowerManager.THERMAL_STATUS_CRITICAL:
                return "serious";
            case PowerManager.THERMAL_STATUS_EMERGENCY:
            case PowerManager.THERMAL_STATUS_SHUTDOWN:
                return "critical";
            default:
                return "unknown";
        }
    }

    private static Object readPowerSaveMode(Context context) {
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return pm != null ? (Object) pm.isPowerSaveMode() : JSONObject.NULL;
    }

    /** A BatteryManager integer property, or JSON null when unavailable/sentinel. */
    private static Object readBatteryProperty(BatteryManager bm, int property) {
        if (bm == null) {
            return JSONObject.NULL;
        }
        int value = bm.getIntProperty(property);
        // BatteryManager returns Integer.MIN_VALUE for unsupported properties.
        return value == Integer.MIN_VALUE ? JSONObject.NULL : (Object) value;
    }

    /** Total PSS of this process in MB, or JSON null when the probe fails. */
    private static Object readTotalPssMb() {
        try {
            Debug.MemoryInfo info = new Debug.MemoryInfo();
            Debug.getMemoryInfo(info);
            // getTotalPss() is in KB.
            return info.getTotalPss() / 1024.0;
        } catch (RuntimeException e) {
            return JSONObject.NULL;
        }
    }

    private static Object readAvailableRamMb(Context context) {
        ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) {
            return JSONObject.NULL;
        }
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(info);
        return info.availMem / 1_048_576.0;
    }

    /**
     * Device total physical RAM in MB. Feeds the renderer's RAM-tier gating
     * (#14390) on paths where the synchronous {@code ElizaNativeBridge} read
     * is unavailable; JSON null when the OS cannot provide it.
     */
    private static Object readTotalRamMb(Context context) {
        ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) {
            return JSONObject.NULL;
        }
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(info);
        return info.totalMem > 0 ? info.totalMem / 1_048_576.0 : JSONObject.NULL;
    }

    /**
     * Process user+system CPU time in ms from {@code /proc/self/stat} fields 14
     * (utime) and 15 (stime), in clock ticks, converted via
     * {@code sysconf(_SC_CLK_TCK)}.
     */
    private static Object readProcessCpuTimeMs() {
        try {
            byte[] raw = Files.readAllBytes(Paths.get("/proc/self/stat"));
            String stat = new String(raw, StandardCharsets.UTF_8);
            // The comm field (2nd) is parenthesised and may contain spaces; split
            // after the closing ')' so the remaining fields are space-delimited.
            int close = stat.lastIndexOf(')');
            if (close < 0 || close + 2 > stat.length()) {
                return JSONObject.NULL;
            }
            String[] fields = stat.substring(close + 2).trim().split("\\s+");
            // After comm, field index 0 is "state"; utime is field 14 and stime
            // field 15 in the 1-based proc layout → indices 11 and 12 here.
            if (fields.length < 13) {
                return JSONObject.NULL;
            }
            long utime = Long.parseLong(fields[11]);
            long stime = Long.parseLong(fields[12]);
            long ticksPerSecond = Os.sysconf(OsConstants._SC_CLK_TCK);
            if (ticksPerSecond <= 0) {
                ticksPerSecond = 100; // POSIX-conventional default on Android
            }
            return ((utime + stime) * 1000.0) / ticksPerSecond;
        } catch (IOException | RuntimeException e) {
            return JSONObject.NULL;
        }
    }
}
