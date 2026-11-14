package ai.elizaos.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
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
import org.json.JSONObject;

/**
 * Forwards each incoming text to Eliza Cloud. A reply Cloud drafts is never sent from here: it
 * becomes a pending `sms.send.v1` proposal with a review notice ({@link ElizaSmsGatewayFlow},
 * {@link ElizaSmsReplyReviewActivity}), and only the owner's Send press sends it, through the shared
 * reviewed send.
 */
public class ElizaSmsGatewayService extends Service {
    private static final String TAG = "ElizaSmsGateway";

    private static final String EXTRA_SENDER = "sender";
    private static final String EXTRA_BODY = "body";
    private static final String EXTRA_TIMESTAMP = "timestamp";
    private static final String EXTRA_MESSAGE_ID = "messageId";
    /** Absent from work queued by earlier releases; those replies use the default SMS SIM. */
    private static final String EXTRA_SUBSCRIPTION_ID = "subscriptionId";

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
                int subscriptionId = getInputData().getInt(EXTRA_SUBSCRIPTION_ID, -1);
                forwardAndPropose(getApplicationContext(), sender, body, timestamp, messageId, subscriptionId);
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
        final int subscriptionId = intent.getIntExtra(EXTRA_SUBSCRIPTION_ID, -1);

        new Thread(() -> {
            try {
                forwardAndPropose(this, sender, body, timestamp, messageId, subscriptionId);
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
            String messageId,
            int subscriptionId
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
                    .putLong(EXTRA_TIMESTAMP, timestamp)
                    .putInt(EXTRA_SUBSCRIPTION_ID, subscriptionId);
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

    private static void forwardAndPropose(
            Context context,
            String sender,
            String body,
            long timestamp,
            String messageId,
            int subscriptionId
    ) throws Exception {
        ElizaSmsGatewayFlow.Result result = ElizaSmsGatewayFlow.forward(
                new ElizaSmsGatewayFlow.Inbound(sender, body, timestamp, messageId, subscriptionId),
                BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER,
                BuildConfig.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL,
                ElizaSmsReviewedSend.defaultSubscription(),
                ElizaSmsGatewayService::postToCloud,
                proposal -> ElizaSmsReviewedSend.propose(context, proposal),
                System.currentTimeMillis());
        if (result.skipped == ElizaSmsGatewayFlow.Skipped.NO_REPLY) {
            Log.i(TAG, "Cloud handled SMS without a reply for " + sender + ".");
        } else if (result.skipped != null) {
            Log.w(TAG, "Cloud drafted a reply for " + sender + " that cannot be proposed (" + result.skipped + "); nothing was sent.");
        }
    }

    private static JSONObject postToCloud(JSONObject cloudPayload) throws Exception {
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

        byte[] payload = cloudPayload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload);
        }

        int status = connection.getResponseCode();
        String responseText = readResponse(connection, status);
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Cloud gateway failed (" + status + "): " + responseText);
        }
        Log.i(TAG, "Cloud gateway accepted SMS with HTTP " + status + ".");
        return responseText.isEmpty() ? new JSONObject() : new JSONObject(responseText);
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
}
