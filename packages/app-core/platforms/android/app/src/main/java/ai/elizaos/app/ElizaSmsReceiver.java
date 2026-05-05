package ai.elizaos.app;

import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.text.TextUtils;
import android.util.Log;

public class ElizaSmsReceiver extends BroadcastReceiver {
    private static final String TAG = "ElizaSmsReceiver";

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

        Uri messageUri = persistIncomingSms(context, sender, body.toString(), timestamp);
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
        if (messageUri != null) {
            route.appendQueryParameter("messageUri", messageUri.toString());
            route.appendQueryParameter("messageId", messageUri.getLastPathSegment());
        }

        Intent launch = new Intent(context, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(launch);
    }

    private static Uri persistIncomingSms(Context context, String sender, String body, long timestamp) {
        if (TextUtils.isEmpty(sender) || TextUtils.isEmpty(body)) {
            Log.w(TAG, "SMS deliver intent did not include sender and body; not inserting provider row.");
            return null;
        }

        long receivedAt = timestamp > 0L ? timestamp : System.currentTimeMillis();
        ContentValues values = new ContentValues();
        values.put(Telephony.Sms.ADDRESS, sender);
        values.put(Telephony.Sms.BODY, body);
        values.put(Telephony.Sms.DATE, receivedAt);
        values.put(Telephony.Sms.DATE_SENT, receivedAt);
        values.put(Telephony.Sms.READ, 0);
        values.put(Telephony.Sms.SEEN, 0);
        values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX);

        Uri inserted = context.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, values);
        if (inserted == null) {
            Log.w(TAG, "SMS provider did not return an inserted inbox URI.");
        }
        return inserted;
    }
}
