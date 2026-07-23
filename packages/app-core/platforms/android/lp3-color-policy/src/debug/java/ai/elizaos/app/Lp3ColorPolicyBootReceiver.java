/**
 * Reconciles the direct-distribution LP3 color service at boot, package
 * replacement, and explicit same-UID operator commands. Its device-protected
 * private preference survives reboot and in-place updates without creating a
 * cross-app control surface.
 */
package ai.elizaos.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public final class Lp3ColorPolicyBootReceiver extends BroadcastReceiver {
    private static final String TAG = "ElizaLp3Color";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Lp3ColorPolicy.acceptsTrigger(action)) return;
        try {
            Lp3ColorPolicy.OperatorCommand command = Lp3ColorPolicy.operatorCommand(action);
            if (command == Lp3ColorPolicy.OperatorCommand.ENABLE) {
                Lp3ColorPolicyService.setOptedIn(context, true);
            } else if (command == Lp3ColorPolicy.OperatorCommand.DISABLE) {
                Lp3ColorPolicyService.setOptedIn(context, false);
            }
            Lp3ColorPolicyService.sync(context, action);
        } catch (RuntimeException error) {
            // error-policy:J1 Android receiver boundary — private preference
            // persistence must be observable; an operator command that cannot
            // be committed must never appear successful in logcat.
            Log.e(TAG, "[Lp3ColorPolicy] operator command failed; action=" + action, error);
            context.getApplicationContext().stopService(
                new Intent(context, Lp3ColorPolicyService.class)
            );
        }
    }
}
