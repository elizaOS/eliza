package ai.elizaos.app;

import android.app.AppOpsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Process;
import android.util.Log;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

public class ElizaBootReceiver extends BroadcastReceiver {

    private static final String TAG = "ElizaBootReceiver";

    // Capacitor Preferences default group — mirrored from GatewayConnectionService.
    private static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";
    static final String BACKGROUND_ENABLED_KEY = "eliza:background-enabled";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.MY_PACKAGE_REPLACED".equals(action)) {
            return;
        }
        // PACKAGE_USAGE_STATS has both a manifest permission (granted via
        // privapp-permissions whitelist) and an appop. Only the privileged
        // AOSP/system image is allowed to flip the appop itself; stock APK
        // installs must not try hidden AppOpsManager#setMode because Android
        // will reject it with MANAGE_APP_OPS_MODES and log a scary startup
        // warning even though local chat/voice still work.
        if (BuildConfig.AOSP_BUILD && isBrandedDevice()) {
            allowUsageStatsAppOp(context);
        } else {
            Log.i(TAG, "Skipping GET_USAGE_STATS appop auto-grant on non-privileged APK install.");
        }
        GatewayConnectionService.start(context);
        // Only auto-start the on-device agent on branded devices (AOSP /
        // ElizaOS) or when the user has opted into Local runtime mode.
        // See ElizaAgentService.shouldAutoStart for the exact gate.
        if (ElizaAgentService.shouldAutoStart(context)) {
            ElizaAgentService.start(context);
        }

        // Re-arm the WorkManager periodic refresh after boot / package
        // replacement. WorkManager persists its job DB across reboots on
        // most OEM ROMs, but some clear it on BOOT_COMPLETED; KEEP policy
        // makes this safe to call unconditionally.
        SharedPreferences prefs = context.getSharedPreferences(
            CAPACITOR_PREFS_GROUP,
            Context.MODE_PRIVATE
        );
        if (isBackgroundEnabled(prefs)) {
            ElizaWorkScheduler.enqueuePeriodic(context);
        } else {
            Log.i(TAG, "background disabled by user; skipping WorkManager re-enqueue on " + action);
        }
    }

    /**
     * Reads the background-enabled toggle. Capacitor Preferences stores booleans
     * as the string {@code "true"} / {@code "false"} when written via
     * {@code Preferences.set({ key, value: String(bool) })}, so we accept both
     * the string form and the native boolean form. Default: enabled.
     */
    static boolean isBackgroundEnabled(SharedPreferences prefs) {
        if (prefs == null || !prefs.contains(BACKGROUND_ENABLED_KEY)) {
            return true;
        }
        try {
            return prefs.getBoolean(BACKGROUND_ENABLED_KEY, true);
        } catch (ClassCastException notBoolean) {
            String stringValue = prefs.getString(BACKGROUND_ENABLED_KEY, "true");
            return !"false".equalsIgnoreCase(stringValue);
        }
    }

    private static void allowUsageStatsAppOp(Context context) {
        if (context.checkSelfPermission("android.permission.MANAGE_APP_OPS_MODES")
                != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "MANAGE_APP_OPS_MODES not granted; usage-stats appop requires user/system grant.");
            return;
        }
        AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) {
            return;
        }
        try {
            Method setMode = AppOpsManager.class.getMethod(
                "setMode", String.class, int.class, String.class, int.class);
            setMode.invoke(
                appOps,
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.getPackageName(),
                AppOpsManager.MODE_ALLOWED);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof SecurityException) {
                // Non-priv installs cannot setMode on themselves.
                Log.i(TAG, "GET_USAGE_STATS appop grant denied; user/system grant required.");
                return;
            }
            Log.w(TAG, "GET_USAGE_STATS appop reflective grant failed.", error);
        } catch (ReflectiveOperationException error) {
            // Method missing or hidden-api enforcement blocked the call.
            // The user can still grant via Settings → Special Access.
            Log.w(TAG, "GET_USAGE_STATS appop reflective grant unavailable.", error);
        } catch (SecurityException error) {
            // Non-priv installs cannot setMode on themselves.
            Log.w(TAG, "GET_USAGE_STATS appop grant denied; user grant required.", error);
        }
    }

    private static boolean isBrandedDevice() {
        return !readSystemProperty("ro.elizaos.product").isEmpty();
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> systemProperties = Class.forName("android.os.SystemProperties");
            Method get = systemProperties.getMethod("get", String.class, String.class);
            Object value = get.invoke(null, key, "");
            return value instanceof String ? (String) value : "";
        } catch (Exception error) {
            Log.d(TAG, "SystemProperties reflection unavailable while reading " + key, error);
            return "";
        }
    }
}
