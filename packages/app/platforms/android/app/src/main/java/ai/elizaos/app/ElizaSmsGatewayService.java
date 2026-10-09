package ai.elizaos.app;

import android.app.Service;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;
import android.provider.Telephony;
import android.telephony.SmsManager;
import android.text.TextUtils;
import android.util.Log;
import ai.elizaos.app.BuildConfig;
import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

public class ElizaSmsGatewayService extends Service {
    private static final String TAG = "ElizaSmsGateway";

    private static final String EXTRA_SENDER = "sender";
    private static final String EXTRA_BODY = "body";
    private static final String EXTRA_TIMESTAMP = "timestamp";
    private static final String EXTRA_MESSAGE_ID = "messageId";

    public static class SmsGatewayWorker extends Worker {
        public SmsGatewayWorker(Context context, WorkerParameters params) {
            super(context, params);
        }

        @Override
        public Result doWork() {
            try {
                String sender = getInputData().getString(EXTRA_SENDER);
                String body = getInputData().getString(EXTRA_BODY);
                long timestamp = getInputData().getLong(EXTRA_TIMESTAMP, System.currentTimeMillis());
                String messageId = getInputData().getString(EXTRA_MESSAGE_ID);
                forwardAndReply(getApplicationContext(), sender, body, timestamp, messageId);
                return Result.success();
            } catch (Exception error) {
                Log.e(TAG, "SMS gateway worker failed.", error);
                return Result.retry();
            }
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        final String sender = intent.getStringExtra(EXTRA_SENDER);
        final String body = intent.getStringExtra(EXTRA_BODY);
        final long timestamp = intent.getLongExtra(EXTRA_TIMESTAMP, System.currentTimeMillis());
        final String messageId = intent.getStringExtra(EXTRA_MESSAGE_ID);

        new Thread(() -> {
            try {
                forwardAndReply(this, sender, body, timestamp, messageId);
            } catch (Exception error) {
                Log.e(TAG, "SMS gateway forwarding failed.", error);
            } finally {
                stopSelf(startId);
            }
        }, "eliza-sms-gateway").start();

        return START_NOT_STICKY;
    }

    public static boolean start(
            Context context,
            String sender,
            String body,
            long timestamp,
            String messageId
    ) {
        if (!BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_ENABLED) {
            return false;
        }
        if (TextUtils.isEmpty(BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_SECRET)) {
            Log.w(TAG, "Android SMS gateway is enabled but secret is missing.");
            return false;
        }
        if (TextUtils.isEmpty(sender) || TextUtils.isEmpty(body)) {
            return false;
        }

        try {
            Data.Builder input = new Data.Builder()
                    .putString(EXTRA_SENDER, sender)
                    .putString(EXTRA_BODY, body)
                    .putLong(EXTRA_TIMESTAMP, timestamp);
            if (!TextUtils.isEmpty(messageId)) {
                input.putString(EXTRA_MESSAGE_ID, messageId);
            }

            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(SmsGatewayWorker.class)
                    .setInputData(input.build())
                    .build();
            WorkManager.getInstance(context).enqueue(request);
            Log.i(TAG, "Queued SMS gateway work for " + sender + ".");
            return true;
        } catch (RuntimeException error) {
            Log.e(TAG, "Could not enqueue Android SMS gateway work.", error);
            return false;
        }
    }

    private static void forwardAndReply(
            Context context,
            String sender,
            String body,
            long timestamp,
            String messageId
    ) throws Exception {
        JSONObject reply = postToCloud(sender, body, timestamp, messageId);
        String replyText = reply.optString("replyText", "").trim();
        if (replyText.isEmpty()) {
            Log.i(TAG, "Cloud handled SMS without a reply for " + sender + ".");
            return;
        }

        SmsManager smsManager = SmsManager.getDefault();
        ArrayList<String> parts = smsManager.divideMessage(replyText);
        Log.i(TAG, "Sending SMS gateway reply to " + sender + " in " + parts.size() + " part(s).");
        if (parts.size() > 1) {
            smsManager.sendMultipartTextMessage(sender, null, parts, null, null);
        } else {
            smsManager.sendTextMessage(sender, null, replyText, null, null);
        }
        persistSentMessage(context, sender, replyText);
        Log.i(TAG, "SMS gateway reply sent and persisted for " + sender + ".");
    }

    private static JSONObject postToCloud(
            String sender,
            String body,
            long timestamp,
            String messageId
    ) throws Exception {
        URL url = new URL(BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("x-eliza-bridge", "android-sms");
        connection.setRequestProperty(
                "x-eliza-gateway-secret",
                BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_SECRET
        );

        byte[] payload = buildCloudPayload(sender, body, timestamp, messageId)
                .toString()
                .getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload);
        }

        int status = connection.getResponseCode();
        String responseText = readResponse(connection, status);
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Cloud gateway failed (" + status + "): " + responseText);
        }
        Log.i(TAG, "Cloud gateway accepted SMS from " + sender + " with HTTP " + status + ".");
        return responseText.isEmpty() ? new JSONObject() : new JSONObject(responseText);
    }

    private static JSONObject buildCloudPayload(
            String sender,
            String body,
            long timestamp,
            String messageId
    ) throws Exception {
        String id = !TextUtils.isEmpty(messageId)
                ? messageId
                : "android-sms-" + sender + "-" + timestamp;

        JSONObject metadata = new JSONObject();
        metadata.put("localPhoneNumber", BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER);
        metadata.put("phoneNumber", BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER);
        metadata.put("phoneAccountId", BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER);
        metadata.put("phoneAccountLabel", BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL);
        metadata.put("androidSmsGateway", true);

        JSONObject handle = new JSONObject();
        handle.put("address", sender);
        handle.put("service", "SMS");

        JSONObject chat = new JSONObject();
        chat.put("guid", "SMS;-;" + sender);
        chat.put("chatIdentifier", sender);
        JSONArray chats = new JSONArray();
        chats.put(chat);

        JSONObject data = new JSONObject();
        data.put("guid", id);
        data.put("text", body);
        data.put("isFromMe", false);
        data.put("handle", handle);
        data.put("chats", chats);
        data.put("dateCreated", timestamp);
        data.put("metadata", metadata);

        JSONObject payload = new JSONObject();
        payload.put("type", "new-message");
        payload.put("data", data);
        return payload;
    }

    private static String readResponse(HttpURLConnection connection, int status) throws Exception {
        InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
        if (stream == null) {
            return "";
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                stream,
                StandardCharsets.UTF_8
        ))) {
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
            }
            return body.toString();
        }
    }

    private static void persistSentMessage(Context context, String recipient, String message) {
        long sentAt = System.currentTimeMillis();
        ContentValues values = new ContentValues();
        values.put(Telephony.Sms.ADDRESS, recipient);
        values.put(Telephony.Sms.BODY, message);
        values.put(Telephony.Sms.DATE, sentAt);
        values.put(Telephony.Sms.DATE_SENT, sentAt);
        values.put(Telephony.Sms.READ, 1);
        values.put(Telephony.Sms.SEEN, 1);
        values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT);

        Uri inserted = context.getContentResolver().insert(Telephony.Sms.Sent.CONTENT_URI, values);
        if (inserted == null) {
            Log.w(TAG, "SMS provider returned no sent row URI for gateway reply.");
        }
    }
}
