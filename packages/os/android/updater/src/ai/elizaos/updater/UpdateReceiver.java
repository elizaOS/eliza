package ai.elizaos.updater;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.PowerManager;
import android.telecom.TelecomManager;

/** Schedules the update job at boot and carries out the "Update ready" notification's Restart. */
public final class UpdateReceiver extends BroadcastReceiver {
    static final String ACTION_RESTART = "ai.elizaos.updater.action.RESTART";

    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION_RESTART.equals(intent.getAction())) UpdateJob.schedule(context);
        // A call or a communication session leaves the notification in place. Telecom sees a call ringing
        // on a silenced phone, which never reaches MODE_RINGTONE; the audio mode sees sessions Telecom does not.
        else if (context.getSystemService(AudioManager.class).getMode() == AudioManager.MODE_NORMAL
                && !context.getSystemService(TelecomManager.class).isInCall())
            context.getSystemService(PowerManager.class).reboot(null);
    }
}
