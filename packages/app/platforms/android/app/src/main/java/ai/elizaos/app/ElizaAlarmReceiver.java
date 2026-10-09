package ai.elizaos.app;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Internal exact-alarm delivery and system restoration; no agent/runtime dependency. */
public final class ElizaAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (!ElizaAlarms.ACTION_FIRE.equals(action) && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_TIME_CHANGED.equals(action)
                && !Intent.ACTION_TIMEZONE_CHANGED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                if (ElizaAlarms.ACTION_FIRE.equals(action)) {
                    String id = intent.getStringExtra(ElizaAlarms.EXTRA_ID);
                    long generation = intent.getLongExtra(ElizaAlarms.EXTRA_GENERATION, -1);
                    ElizaAlarms.Occurrence due = ElizaAlarms.claimDue(context, id, generation, System.currentTimeMillis());
                    while (due != null) {
                        try {
                            ElizaAlarmRingingService.start(context, due);
                            break;
                        } catch (RuntimeException error) {
                            // This token was claimed but has no playback host. Persist its failure
                            // before advancing so a later foreground refresh cannot revive it.
                            ElizaAlarms.retireDelivery(context, due.id, due.generation);
                            Log.e("ElizaAlarms", "Native alarm playback host could not start", error);
                            due = ElizaAlarms.peekActive(context);
                        }
                    }
                } else {
                    // Restore broadcasts have no media-playback foreground-service exemption.
                    // Confirmed active sound resumes through a future exact-alarm delivery instead.
                    ElizaAlarms.reconcile(context, true);
                }
            } catch (RuntimeException error) {
                // error-policy:J1 durable/platform failures remain explicit in native state and logs.
                Log.e("ElizaAlarms", "Native alarm delivery or restoration failed", error);
            } finally { pending.finish(); }
        }, "eliza-native-alarm").start();
    }
}
