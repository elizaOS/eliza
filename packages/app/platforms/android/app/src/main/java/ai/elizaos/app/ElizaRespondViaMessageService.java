package ai.elizaos.app;

import android.app.Service;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;
import android.provider.Telephony;
import android.telephony.SmsManager;
import android.text.TextUtils;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;

public class ElizaRespondViaMessageService extends Service {

    private static final String TAG = "ElizaRespondViaMsg";
    private static final String ACTION_RESPOND_VIA_MESSAGE = "android.intent.action.RESPOND_VIA_MESSAGE";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            handleIntent(intent);
        } catch (RuntimeException error) {
            Log.e(TAG, "Respond-via-message request failed.", error);
            throw error;
        } finally {
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    private void handleIntent(Intent intent) {
        if (intent == null || !ACTION_RESPOND_VIA_MESSAGE.equals(intent.getAction())) {
            return;
        }

        String message = firstNonEmpty(
                intent.getStringExtra(Intent.EXTRA_TEXT),
                intent.getStringExtra("sms_body")
        );
        if (TextUtils.isEmpty(message)) {
            Log.w(TAG, "Respond-via-message request did not include message text.");
            return;
        }

        List<String> recipients = parseRecipients(intent.getData());
        if (recipients.isEmpty()) {
            Log.w(TAG, "Respond-via-message request did not include recipients.");
            return;
        }

        SmsManager smsManager = SmsManager.getDefault();
        for (String recipient : recipients) {
            sendTextMessage(smsManager, recipient, message);
            persistSentMessage(recipient, message);
        }
    }

    private static String firstNonEmpty(String first, String second) {
        if (!TextUtils.isEmpty(first)) {
            return first;
        }
        return second;
    }

    private static List<String> parseRecipients(Uri uri) {
        List<String> recipients = new ArrayList<>();
        if (uri == null || TextUtils.isEmpty(uri.getSchemeSpecificPart())) {
            return recipients;
        }

        String value = uri.getSchemeSpecificPart();
        int queryIndex = value.indexOf('?');
        if (queryIndex >= 0) {
            value = value.substring(0, queryIndex);
        }
        value = Uri.decode(value);

        for (String rawRecipient : value.split("[,;]")) {
            String recipient = rawRecipient.trim();
            if (!recipient.isEmpty()) {
                recipients.add(recipient);
            }
        }
        return recipients;
    }

    private static void sendTextMessage(SmsManager smsManager, String recipient, String message) {
        ArrayList<String> parts = smsManager.divideMessage(message);
        if (parts.size() > 1) {
            smsManager.sendMultipartTextMessage(recipient, null, parts, null, null);
        } else {
            smsManager.sendTextMessage(recipient, null, message, null, null);
        }
    }

    private void persistSentMessage(String recipient, String message) {
        long sentAt = System.currentTimeMillis();
        ContentValues values = new ContentValues();
        values.put(Telephony.Sms.ADDRESS, recipient);
        values.put(Telephony.Sms.BODY, message);
        values.put(Telephony.Sms.DATE, sentAt);
        values.put(Telephony.Sms.DATE_SENT, sentAt);
        values.put(Telephony.Sms.READ, 1);
        values.put(Telephony.Sms.SEEN, 1);
        values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT);

        Uri inserted = getContentResolver().insert(Telephony.Sms.Sent.CONTENT_URI, values);
        if (inserted == null) {
            throw new IllegalStateException("SMS provider returned no sent row URI.");
        }
    }
}
