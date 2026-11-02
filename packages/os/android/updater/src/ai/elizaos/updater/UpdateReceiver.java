package ai.elizaos.updater;

import android.Manifest;
import android.app.AppOpsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.PowerManager;
import android.os.Process;
import android.telecom.TelecomManager;

/** Schedules the update job at boot and carries out the "Update ready" notification's Restart. */
public final class UpdateReceiver extends BroadcastReceiver {
    static final String ACTION_RESTART = "ai.elizaos.updater.action.RESTART";

    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION_RESTART.equals(intent.getAction())) {
            UpdateJob.schedule(context);
            return;
        }
        // A call, a communication session or an unknown call state leaves the notification in place. Telecom
        // sees a call ringing on a silenced phone, which never reaches MODE_RINGTONE; the audio mode sees
        // sessions Telecom does not. isInCall reads false under a refused app-op, so that comes first.
        TelecomManager telecom = context.getSystemService(TelecomManager.class);
        if (telecom != null
                && context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
                && context.getSystemService(AppOpsManager.class).checkOpNoThrow(AppOpsManager.OPSTR_READ_PHONE_STATE, Process.myUid(), context.getPackageName()) == AppOpsManager.MODE_ALLOWED
                && context.getSystemService(AudioManager.class).getMode() == AudioManager.MODE_NORMAL
                && !telecom.isInCall())
            context.getSystemService(PowerManager.class).reboot(null);
    }
}
