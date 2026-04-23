package ai.elizaos.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class MiladyBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            return;
        }
        GatewayConnectionService.start(context);
    }
}
