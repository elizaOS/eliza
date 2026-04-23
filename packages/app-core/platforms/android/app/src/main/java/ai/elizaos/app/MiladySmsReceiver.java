package ai.elizaos.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.text.TextUtils;

public class MiladySmsReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        String sender = null;
        long timestamp = 0L;
        StringBuilder body = new StringBuilder();
        for (SmsMessage message : messages) {
            if (message == null) {
                continue;
            }
            if (TextUtils.isEmpty(sender)) {
                sender = message.getOriginatingAddress();
            }
            if (timestamp == 0L) {
                timestamp = message.getTimestampMillis();
            }
            String part = message.getMessageBody();
            if (!TextUtils.isEmpty(part)) {
                body.append(part);
            }
        }

        Uri.Builder route = Uri.parse("ai.elizaos.app://messages").buildUpon()
                .appendQueryParameter("event", "sms-deliver");
        if (!TextUtils.isEmpty(sender)) {
            route.appendQueryParameter("sender", sender);
        }
        if (body.length() > 0) {
            route.appendQueryParameter("body", body.toString());
        }
        if (timestamp > 0L) {
            route.appendQueryParameter("timestamp", Long.toString(timestamp));
        }

        Intent launch = new Intent(context, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(launch);
    }
}
