package ai.elizaos.app;

import ai.eliza.plugins.messages.SmsSendJournal;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Pending `sms.send.v1` proposals: replies Eliza Cloud drafted for incoming texts, waiting for the
 * owner's review. A proposal is only data; nothing here can send. It leaves the store when the owner
 * sends it through the reviewed send, discards it, or moves it to the Messages composer.
 *
 * The operation ID is derived from the incoming message, so a retried gateway worker proposes the same
 * operation again instead of a second one, and the reviewed send's journal refuses to send it twice.
 * Plain Java so the JVM tests exercise it without Android.
 */
final class ElizaSmsReplyProposals {
    static final int MAX_PENDING = 50;
    /** A draft older than this is dropped unsent: a reply that late is no longer the reply that was reviewed for. */
    static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;

    interface Storage {
        String read() throws Exception;
        void write(String value) throws Exception;
    }

    /** One reviewed-send operation for one recipient, plus the incoming message it answers. */
    static final class Proposal {
        final String operationId, recipient, body, inboundId;
        final int subscriptionId;
        final long createdAt;

        Proposal(String operationId, String recipient, String body, int subscriptionId, String inboundId, long createdAt) {
            SmsSendJournal.validate(operationId, new String[] { recipient }, body, subscriptionId);
            if (inboundId == null || inboundId.isEmpty() || inboundId.length() > 256 || createdAt <= 0) {
                throw new IllegalArgumentException("Invalid SMS reply proposal");
            }
            this.operationId = operationId;
            this.recipient = recipient;
            this.body = body;
            this.subscriptionId = subscriptionId;
            this.inboundId = inboundId;
            this.createdAt = createdAt;
        }

        String[] recipients() {
            return new String[] { recipient };
        }

        /** The exact `sms_send` operation of the shared contract. */
        JSONObject operation() throws Exception {
            return new JSONObject()
                    .put("type", "sms_send")
                    .put("recipients", new JSONArray().put(recipient))
                    .put("body", body)
                    .put("subscriptionId", subscriptionId);
        }

        JSONObject toJson() throws Exception {
            return new JSONObject()
                    .put("operationId", operationId)
                    .put("recipient", recipient)
                    .put("body", body)
                    .put("subscriptionId", subscriptionId)
                    .put("inboundId", inboundId)
                    .put("createdAt", createdAt);
        }

        static Proposal fromJson(JSONObject value) throws Exception {
            return new Proposal(
                    value.getString("operationId"),
                    value.getString("recipient"),
                    value.getString("body"),
                    value.getInt("subscriptionId"),
                    value.getString("inboundId"),
                    value.getLong("createdAt"));
        }
    }

    private final Storage storage;
    private final Map<String, Proposal> pending = new LinkedHashMap<>();
    private boolean loaded;

    ElizaSmsReplyProposals(Storage storage) {
        this.storage = storage;
    }

    /**
     * Stores a new proposal. A proposal for an operation that is already pending keeps the first one,
     * so the owner always reviews the text that is shown. Returns whether it was added.
     */
    synchronized boolean add(Proposal proposal, long now) throws Exception {
        load();
        boolean changed = prune(now);
        if (pending.containsKey(proposal.operationId)) {
            if (changed) save();
            return false;
        }
        Iterator<String> oldest = pending.keySet().iterator();
        while (pending.size() >= MAX_PENDING && oldest.hasNext()) {
            oldest.next();
            oldest.remove();
        }
        pending.put(proposal.operationId, proposal);
        save();
        return true;
    }

    synchronized Proposal get(String operationId, long now) throws Exception {
        load();
        if (prune(now)) save();
        return pending.get(operationId);
    }

    /** Removes a proposal once the owner decided it. Returns whether one was pending. */
    synchronized boolean remove(String operationId) throws Exception {
        load();
        if (pending.remove(operationId) == null) return false;
        save();
        return true;
    }

    synchronized List<Proposal> pending(long now) throws Exception {
        load();
        if (prune(now)) save();
        return new ArrayList<>(pending.values());
    }

    private boolean prune(long now) {
        boolean changed = false;
        Iterator<Proposal> each = pending.values().iterator();
        while (each.hasNext()) {
            Proposal proposal = each.next();
            if (now - proposal.createdAt > MAX_AGE_MS) {
                each.remove();
                changed = true;
            }
        }
        return changed;
    }

    private void load() throws Exception {
        if (loaded) return;
        String saved = storage.read();
        if (saved != null) {
            JSONObject root = new JSONObject(saved);
            if (root.getInt("version") != 1) throw new IllegalStateException("Unsupported SMS reply proposals");
            JSONArray items = root.getJSONArray("proposals");
            for (int i = 0; i < items.length(); i++) {
                Proposal proposal = Proposal.fromJson(items.getJSONObject(i));
                pending.put(proposal.operationId, proposal);
            }
        }
        loaded = true;
    }

    private void save() throws Exception {
        JSONArray items = new JSONArray();
        for (Proposal proposal : pending.values()) items.put(proposal.toJson());
        storage.write(new JSONObject().put("version", 1).put("proposals", items).toString());
    }

    // ---- Operation identity and addresses --------------------------------------------------------

    /** The reply operation for one incoming message: stable across worker retries, distinct per message. */
    static String operationIdFor(String sender, long timestamp, String inboundId, String inboundBody) {
        String key = sender + "\n" + timestamp + "\n" + (inboundId == null ? "" : inboundId) + "\n" + SmsSendJournal.sha256(inboundBody == null ? "" : inboundBody);
        return "sms-reply-" + SmsSendJournal.sha256(key).substring(0, 40);
    }

    /** The key of the incoming message a proposal answers. */
    static String inboundKey(String sender, long timestamp, String inboundId) {
        return inboundId != null && !inboundId.isEmpty() ? inboundId : "android-sms-" + sender + "-" + timestamp;
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
