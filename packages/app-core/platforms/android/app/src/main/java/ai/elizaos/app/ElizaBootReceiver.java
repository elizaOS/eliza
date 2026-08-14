package ai.elizaos.app;

import android.app.AppOpsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Process;
import android.util.Log;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

public class ElizaBootReceiver extends BroadcastReceiver {

    private static final String TAG = "ElizaBootReceiver";

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
        if (isAospBuild(context) && isBrandedDevice()) {
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

        // WorkManager persists jobs across most reboots, but the selected
        // runtime, background preference, or native token may have changed.
        // Reconciliation is idempotent and cancels any stale unique work.
        ElizaWorkScheduler.reconcile(context);
    }

    private static boolean isAospBuild(Context context) {
        try {
            Class<?> buildConfig = Class.forName(context.getPackageName() + ".BuildConfig");
            return buildConfig.getField("AOSP_BUILD").getBoolean(null);
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return false;
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
