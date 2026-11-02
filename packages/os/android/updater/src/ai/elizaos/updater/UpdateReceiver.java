package ai.elizaos.updater;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.PowerManager;

/** Schedules the update job at boot and carries out the "Update ready" notification's Restart. */
public final class UpdateReceiver extends BroadcastReceiver {
    static final String ACTION_RESTART = "ai.elizaos.updater.action.RESTART";

    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION_RESTART.equals(intent.getAction())) UpdateJob.schedule(context);
        // A ringing phone, a call or a communication session leaves the notification in place.
        else if (context.getSystemService(AudioManager.class).getMode() == AudioManager.MODE_NORMAL)
            context.getSystemService(PowerManager.class).reboot(null);
    }
}
