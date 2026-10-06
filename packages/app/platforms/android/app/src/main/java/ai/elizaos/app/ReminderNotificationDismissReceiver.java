package ai.elizaos.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Own immutable delete intents; no notification-listener permission. */
public final class ReminderNotificationDismissReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String channel = intent.getStringExtra("channelId");
        if (channel != null && (context.getPackageName() + ".REMINDER_GROUP_DISMISSED." + channel).equals(intent.getAction())) {
            ElizaReminderMessagingService.onReminderGroupDismissed(context, channel);
        } else {
            ElizaReminderMessagingService.onReminderDismissed(context, intent);
        }
    }
}
