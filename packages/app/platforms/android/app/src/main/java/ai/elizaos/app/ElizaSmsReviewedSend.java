package ai.elizaos.app;

import ai.eliza.plugins.messages.ReviewedSmsSend;
import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.telephony.SubscriptionManager;
import android.util.Log;
import java.io.File;

/**
 * This app's identity for the shared reviewed SMS send ({@link ReviewedSmsSend}) and the review
 * notice of a Cloud-drafted reply. The journal and the pending drafts live in Keystore-encrypted slots
 * in no-backup storage; the slot names, alias, channel and notice tag are installed identity.
 */
final class ElizaSmsReviewedSend {
    private ElizaSmsReviewedSend() {}

    static final String TAG = "ElizaSmsGateway";
    static final String CHANNEL_ID = "eliza_sms_reply_review";
    static final String NOTICE_TAG = "eliza-sms-reply";
    private static final String JOURNAL_SLOT = "eliza-sms-send-journal:v1";
    private static final String PROPOSALS_SLOT = "eliza-sms-reply-proposals:v1";
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

    private static ElizaSmsReplyProposals proposals;

    /** The process's pending drafts. Blocking storage: call it off the main thread. */
    static synchronized ElizaSmsReplyProposals proposals(Context context) {
        if (proposals == null) {
            final JsonCredentialSlots slots = slots(context);
            proposals = new ElizaSmsReplyProposals(new ElizaSmsReplyProposals.Storage() {
                @Override public String read() throws Exception { return slots.read(PROPOSALS_SLOT); }
                @Override public void write(String value) throws Exception { slots.write(PROPOSALS_SLOT, value); }
            });
        }
        return proposals;
    }

    /** The SIM for a reply when Android did not name the one a text arrived on, or -1. */
    static int defaultSubscription() {
        int subscription = SubscriptionManager.getDefaultSmsSubscriptionId();
        if (subscription < 0) subscription = SubscriptionManager.getDefaultSubscriptionId();
        return subscription;
    }

    /** Stores a Cloud-drafted reply and shows its review notice, unless that operation was already journaled. */
    static void propose(Context context, ElizaSmsReplyProposals.Proposal proposal) throws Exception {
        if (ReviewedSmsSend.known(context, HOST, proposal.operationId)) {
            Log.i(TAG, "SMS gateway reply for this message was already reviewed; not proposing it again.");
            return;
        }
        proposals(context).add(proposal, System.currentTimeMillis());
        showReviewNotice(context, proposal);
        Log.i(TAG, "Proposed SMS gateway reply for review: " + proposal.operationId);
    }

    private static NotificationManager channel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Text replies to review", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Replies Eliza drafted for your texts. Nothing is sent until you review it and press Send.");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
        return manager;
    }

    static void showReviewNotice(Context context, ElizaSmsReplyProposals.Proposal proposal) {
        NotificationManager manager = channel(context);
        if (manager == null) return;
        if (!manager.areNotificationsEnabled()) {
            Log.w(TAG, "Notifications are off; the SMS reply waits for review without a notice.");
        }
        Intent review = new Intent(context, ElizaSmsReplyReviewActivity.class)
                .setData(Uri.fromParts("elizaos-sms-review", proposal.operationId, null))
                .putExtra(ElizaSmsReplyReviewActivity.EXTRA_OPERATION_ID, proposal.operationId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(context, 0, review, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification hidden = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_action_chat)
                .setContentTitle("A text reply needs your review")
                .build();
        Notification notice = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_action_chat)
                .setContentTitle("Review reply to " + proposal.recipient)
                .setContentText(proposal.body)
                .setStyle(new Notification.BigTextStyle().bigText(proposal.body + "\n\nNothing is sent until you review it and press Send."))
                .setContentIntent(open)
                .setAutoCancel(false)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(hidden)
                .build();
        try {
            manager.notify(NOTICE_TAG, proposal.operationId.hashCode(), notice);
        } catch (SecurityException denied) {
            Log.w(TAG, "SMS reply review notice could not be shown.");
        }
    }

    static void cancelReviewNotice(Context context, String operationId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTICE_TAG, operationId.hashCode());
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

    /** The Messages composer route with a draft, for editing before a send (the composer reviews its own sends). */
    static Intent composeIntent(Context context, String recipient, String body, String source) {
        Uri.Builder route = Uri.parse("elizaos://messages/compose").buildUpon().appendQueryParameter("source", source);
        if (recipient != null && !recipient.isEmpty()) route.appendQueryParameter("recipient", recipient);
        if (body != null && !body.isEmpty()) route.appendQueryParameter("body", body);
        return new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(route.build())
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }
}
