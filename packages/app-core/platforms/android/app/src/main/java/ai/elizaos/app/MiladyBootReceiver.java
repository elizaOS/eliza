package ai.elizaos.app;

import android.app.AppOpsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.util.Log;
import java.lang.reflect.Method;

public class MiladyBootReceiver extends BroadcastReceiver {

    private static final String TAG = "MiladyBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            return;
        }
        // PACKAGE_USAGE_STATS has both a manifest permission (granted via
        // privapp-permissions whitelist) and an appop. The privapp grant
        // covers the permission; the appop must be flipped to ALLOWED
        // separately. AppOpsManager#setMode(String, int, String, int)
        // is hidden API, so we invoke via reflection — visible to system
        // apps at runtime, no-ops cleanly otherwise.
        allowUsageStatsAppOp(context);
        GatewayConnectionService.start(context);
    }

    private static void allowUsageStatsAppOp(Context context) {
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
        } catch (ReflectiveOperationException error) {
            // Method missing or hidden-api enforcement blocked the call.
            // The user can still grant via Settings → Special Access.
            Log.w(TAG, "GET_USAGE_STATS appop reflective grant unavailable.", error);
        } catch (SecurityException error) {
            // Non-priv installs cannot setMode on themselves.
            Log.w(TAG, "GET_USAGE_STATS appop grant denied; user grant required.", error);
        }
    }
}
