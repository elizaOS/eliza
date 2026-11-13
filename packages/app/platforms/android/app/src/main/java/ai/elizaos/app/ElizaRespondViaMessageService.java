package ai.elizaos.app;

import ai.eliza.plugins.messages.ReviewedSmsSend;
import ai.eliza.plugins.messages.SmsSendJournal;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;
import android.telephony.SubscriptionManager;
import android.text.TextUtils;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * RESPOND_VIA_MESSAGE: the quick reply the owner picks or types in the incoming-call screen. Only the
 * system's call UI can start it (the service requires SEND_RESPOND_VIA_MESSAGE), and the reply text
 * and recipient are the owner's own choice there, so that choice is the review: no second dialog is
 * shown. The send still goes through the shared reviewed send ({@link ReviewedSmsSend}): journaled
 * before the platform call, receipts per part, a missing receipt reads unknown and is never retried,
 * and one quick reply is one operation, so it can never be sent twice. Android or this app writes the
 * provider row (see {@link ReviewedSmsSend}); this service writes none itself. An outcome other than
 * sent or submitted is shown as a notice, never as a resend prompt.
 */
public class ElizaRespondViaMessageService extends Service {

    private static final String TAG = "ElizaRespondViaMsg";
    private static final String ACTION_RESPOND_VIA_MESSAGE = "android.intent.action.RESPOND_VIA_MESSAGE";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_RESPOND_VIA_MESSAGE.equals(intent.getAction())) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        String message = firstNonEmpty(intent.getStringExtra(Intent.EXTRA_TEXT), intent.getStringExtra("sms_body"));
        Uri data = intent.getData();
        String[] recipients = recipients(data == null ? null : data.getSchemeSpecificPart());
        int subscriptionId = intent.getIntExtra(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, -1);
        if (subscriptionId < 0) subscriptionId = ElizaSmsReviewedSend.defaultSubscription();
        // One operation per quick reply: a repeat of this ID reads its record and never sends again.
        final String operationId = "quick-reply-" + UUID.randomUUID();
        if (TextUtils.isEmpty(message) || recipients == null || subscriptionId < 0) {
            Log.w(TAG, "Respond-via-message request was incomplete; nothing was sent.");
            notSent(operationId, "The quick reply had no text, no usable number or no SIM.");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        try {
            ReviewedSmsSend.send(this, ElizaSmsReviewedSend.HOST, operationId, recipients, message, subscriptionId, status -> {
                Log.i(TAG, "Quick reply finished with status " + status + ".");
                if (!"sent".equals(status) && !"submitted".equals(status) && !"delivered".equals(status)) {
                    ElizaSmsReviewedSend.showOutcomeNotice(this, operationId, "Quick reply", ElizaSmsReviewedSend.label(status));
                }
                stopSelf(startId);
            });
        } catch (IllegalArgumentException invalid) {
            Log.w(TAG, "Respond-via-message request is not a valid SMS; nothing was sent.");
            notSent(operationId, "The quick reply could not be sent as a text message.");
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    private void notSent(String operationId, String reason) {
        ElizaSmsReviewedSend.showOutcomeNotice(this, operationId, "Quick reply not sent", reason + " Nothing was sent.");
    }

    private static String firstNonEmpty(String first, String second) {
        if (!TextUtils.isEmpty(first)) {
            return first;
        }
        return second;
    }

    /**
     * A dialable SMS address in the contract's shape ({@code +} and 2 to 20 digits), or null. Visual
     * separators are dropped; letters (alphanumeric sender IDs), short codes with letters and dial
     * strings are refused, since no reply can be sent to them.
     */
    static String normalizeAddress(String raw) {
        if (raw == null) return null;
        String number = raw.trim().replaceAll("[\\s().-]", "");
        return SmsSendJournal.NUMBER.matcher(number).matches() ? number : null;
    }

    /**
     * The recipients of an {@code sms:}/{@code smsto:} scheme-specific part (already URI-decoded), in
     * order, without duplicates. Null when any recipient is not a dialable number or there are more
     * than the contract allows, so a partial recipient list is never sent.
     */
    static String[] recipients(String schemeSpecificPart) {
        if (schemeSpecificPart == null) return null;
        String value = schemeSpecificPart;
        int query = value.indexOf('?');
        if (query >= 0) value = value.substring(0, query);
        List<String> found = new ArrayList<>();
        for (String raw : value.split("[,;]")) {
            if (raw.trim().isEmpty()) continue;
            String number = normalizeAddress(raw);
            if (number == null) return null;
            if (!found.contains(number)) found.add(number);
        }
        if (found.isEmpty() || found.size() > SmsSendJournal.MAX_RECIPIENTS) return null;
        return found.toArray(new String[0]);
    }
}
