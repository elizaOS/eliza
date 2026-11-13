package ai.elizaos.app;

import ai.eliza.plugins.messages.ReviewedSmsSend;
import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.telephony.SubscriptionManager;
import android.util.Log;
import java.io.File;

/**
 * This app's identity for the shared reviewed SMS send ({@link ReviewedSmsSend}) and the outcome
 * notice of a send the owner chose. The journal lives in a Keystore-encrypted slot in no-backup
 * storage; the slot name, alias, channel and notice tag are installed identity.
 */
final class ElizaSmsReviewedSend {
    private ElizaSmsReviewedSend() {}

    static final String TAG = "ElizaSmsReviewedSend";
    static final String CHANNEL_ID = "eliza_sms_reply_review";
    static final String NOTICE_TAG = "eliza-sms-reply";
    private static final String JOURNAL_SLOT = "eliza-sms-send-journal:v1";
    private static final String RETIRED_NAMESPACE = "eliza-app-sms-operation:v1:";
    private static final String KEY_ALIAS = "ai.elizaos.app.sms-review.v1";
    private static final int SLOT_LIMIT = 1024 * 1024;

    private static JsonCredentialSlots slots(Context context) {
        return new JsonCredentialSlots(
                new File(context.getApplicationContext().getNoBackupFilesDir(), "eliza-sms-review"),
                KEY_ALIAS,
                slot -> SLOT_LIMIT);
    }

    static final ReviewedSmsSend.Host HOST = new ReviewedSmsSend.Host(JOURNAL_SLOT, RETIRED_NAMESPACE, context -> {
        final JsonCredentialSlots slots = slots(context);
        return new ai.eliza.plugins.messages.SmsTelephonyConfiguration.JournalStore() {
            @Override public String read(String slot) throws Exception { return slots.read(slot); }
            @Override public void write(String slot, String value) throws Exception { slots.write(slot, value); }
        };
    });

    /** The SIM for a reply when Android did not name one, or -1. */
    static int defaultSubscription() {
        int subscription = SubscriptionManager.getDefaultSmsSubscriptionId();
        if (subscription < 0) subscription = SubscriptionManager.getDefaultSubscriptionId();
        return subscription;
    }

    private static NotificationManager channel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Text message outcomes", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Texts you chose to send that did not go out as expected.");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
        return manager;
    }

    /** A notice that a send the owner chose did not go out as expected. Never a prompt to resend. */
    static void showOutcomeNotice(Context context, String id, String title, String text) {
        NotificationManager manager = channel(context);
        if (manager == null) return;
        Notification notice = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .build();
        try {
            manager.notify(NOTICE_TAG + "-outcome", id.hashCode(), notice);
        } catch (SecurityException denied) {
            Log.w(TAG, "SMS outcome notice could not be shown.");
        }
    }

    /** The owner-facing meaning of a reviewed-send status. */
    static String label(String status) {
        switch (status) {
            case "submitted": return "Handed to Android; sending is not confirmed yet.";
            case "sent": return "Sent. Delivery is not confirmed.";
            case "delivered": return "Delivered.";
            case "failed": return "Sending failed; some parts may have been sent. It is not retried automatically.";
            case "denied": return "Android did not allow this text to be sent. Nothing was sent.";
            case "cancelled": return "Nothing was sent.";
            case ReviewedSmsSend.NOT_SENT: return "Nothing was sent. Try again.";
            default: return "The outcome is unknown. Check the conversation before sending again.";
        }
    }

}
