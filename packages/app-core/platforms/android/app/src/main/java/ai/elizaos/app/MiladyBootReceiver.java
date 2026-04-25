package ai.elizaos.app;

import android.app.AppOpsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.util.Log;

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
        // separately, which only succeeds when running as a privileged
        // system app. Best-effort — the call no-ops on non-priv installs.
        allowUsageStatsAppOp(context);
        GatewayConnectionService.start(context);
    }

    private static void allowUsageStatsAppOp(Context context) {
        AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) {
            return;
        }
        try {
            appOps.setMode(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.getPackageName(),
                AppOpsManager.MODE_ALLOWED
            );
        } catch (SecurityException error) {
            // Non-priv installs cannot setMode on themselves; fall back to
            // user-driven Special Access grant via the Settings deep link.
            Log.w(TAG, "GET_USAGE_STATS appop grant denied; user grant required.", error);
        }
    }
}
