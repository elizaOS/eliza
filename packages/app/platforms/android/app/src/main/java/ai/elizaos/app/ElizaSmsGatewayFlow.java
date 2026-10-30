package ai.elizaos.app;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The SMS gateway's decision, without Android: forward one incoming text to Eliza Cloud and turn any
 * reply Cloud drafts into a pending `sms.send.v1` proposal for the owner. This flow has no way to
 * send: the only sends are the owner's reviewed ones ({@link ElizaSmsReplyReviewActivity}). Plain
 * Java so the JVM tests drive it with fakes.
 */
final class ElizaSmsGatewayFlow {
    private ElizaSmsGatewayFlow() {}

    /** Posts the gateway payload to Cloud and returns its JSON answer (empty when Cloud sent no body). */
    interface Cloud {
        JSONObject post(JSONObject payload) throws Exception;
    }

    /** Receives a reply proposal for review. Implementations store and show it; none of them sends. */
    interface Review {
        void propose(ElizaSmsReplyProposals.Proposal proposal) throws Exception;
    }

    static final class Inbound {
        final String sender, body, messageId;
        final long timestamp;
        /** The SIM the text arrived on, or -1 when Android did not say. */
        final int subscriptionId;

        Inbound(String sender, String body, long timestamp, String messageId, int subscriptionId) {
            this.sender = sender;
            this.body = body;
            this.timestamp = timestamp;
            this.messageId = messageId;
            this.subscriptionId = subscriptionId;
        }
    }

    /** Why no proposal was made for a Cloud reply. */
    enum Skipped { NO_REPLY, NO_REPLY_ADDRESS, NO_SUBSCRIPTION, INVALID_REPLY }

    static final class Result {
        final ElizaSmsReplyProposals.Proposal proposal;
        final Skipped skipped;

        private Result(ElizaSmsReplyProposals.Proposal proposal, Skipped skipped) {
            this.proposal = proposal;
            this.skipped = skipped;
        }
    }

    /**
     * Forwards the text, then proposes Cloud's reply (if any) to the sender on the SIM it arrived on
     * ({@code fallbackSubscriptionId} when Android did not say). Cloud failures propagate so the worker
     * can retry; a retry proposes the same operation, never a second one.
     */
    static Result forward(Inbound inbound, String localNumber, String localLabel, int fallbackSubscriptionId,
            Cloud cloud, Review review, long now) throws Exception {
        JSONObject reply = cloud.post(payload(inbound, localNumber, localLabel));
        String replyText = reply == null ? "" : reply.optString("replyText", "").trim();
        if (replyText.isEmpty()) return new Result(null, Skipped.NO_REPLY);
        String recipient = ElizaSmsReplyProposals.normalizeAddress(inbound.sender);
        if (recipient == null) return new Result(null, Skipped.NO_REPLY_ADDRESS);
        int subscription = inbound.subscriptionId >= 0 ? inbound.subscriptionId : fallbackSubscriptionId;
        if (subscription < 0) return new Result(null, Skipped.NO_SUBSCRIPTION);
        ElizaSmsReplyProposals.Proposal proposal;
        try {
            proposal = new ElizaSmsReplyProposals.Proposal(
                    ElizaSmsReplyProposals.operationIdFor(inbound.sender, inbound.timestamp, inbound.messageId, inbound.body),
                    recipient,
                    replyText,
                    subscription,
                    ElizaSmsReplyProposals.inboundKey(inbound.sender, inbound.timestamp, inbound.messageId),
                    now);
        } catch (IllegalArgumentException invalid) {
            // For example longer than one reviewed SMS may be. The draft is not shortened behind the owner's back.
            return new Result(null, Skipped.INVALID_REPLY);
        }
        review.propose(proposal);
        return new Result(proposal, null);
    }

    /** The gateway webhook payload (unchanged wire shape). */
    static JSONObject payload(Inbound inbound, String localNumber, String localLabel) throws Exception {
        String id = ElizaSmsReplyProposals.inboundKey(inbound.sender, inbound.timestamp, inbound.messageId);

        JSONObject metadata = new JSONObject();
        metadata.put("localPhoneNumber", localNumber);
        metadata.put("phoneNumber", localNumber);
        metadata.put("phoneAccountId", localNumber);
        metadata.put("phoneAccountLabel", localLabel);
        metadata.put("androidSmsGateway", true);

        JSONObject handle = new JSONObject();
        handle.put("address", inbound.sender);
        handle.put("service", "SMS");

        JSONObject chat = new JSONObject();
        chat.put("guid", "SMS;-;" + inbound.sender);
        chat.put("chatIdentifier", inbound.sender);
        JSONArray chats = new JSONArray();
        chats.put(chat);

        JSONObject data = new JSONObject();
        data.put("guid", id);
        data.put("text", inbound.body);
        data.put("isFromMe", false);
        data.put("handle", handle);
        data.put("chats", chats);
        data.put("dateCreated", inbound.timestamp);
        data.put("metadata", metadata);

        JSONObject payload = new JSONObject();
        payload.put("type", "new-message");
        payload.put("data", data);
        return payload;
    }
}
