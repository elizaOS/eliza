/**
 * Android decoder and reducer for `eliza.native-transcript/v1`. It mirrors the
 * language-neutral contract's structural ordering, dedupe, late-event, and
 * cancellation rules without consulting transcript text or its length.
 */

package ai.elizaos.app;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

final class NativeTranscriptReducer {
    static final String SCHEMA = "eliza.native-transcript/v1";

    static final class ApplyResult {
        final JsonObject view;
        final List<Integer> rejectedIndexes;

        ApplyResult(JsonObject view, List<Integer> rejectedIndexes) {
            this.view = view;
            this.rejectedIndexes = rejectedIndexes;
        }
    }

    private static final class Entry {
        final JsonObject item;
        final long order;
        final long revision;

        Entry(JsonObject item, long order, long revision) {
            this.item = item;
            this.order = order;
            this.revision = revision;
        }
    }

    private final Map<String, Entry> entries = new HashMap<>();
    private final Set<Long> appliedSequences = new HashSet<>();
    private JsonObject speaking;
    private String connection = "live";
    private long lastSequence;

    ApplyResult applyEnvelope(JsonObject envelope) {
        if (!envelope.has("schema") || !SCHEMA.equals(stringValue(envelope.get("schema")))) {
            throw new IllegalArgumentException("Unsupported native transcript schema");
        }
        if (!envelope.has("events") || !envelope.get("events").isJsonArray()) {
            throw new IllegalArgumentException("Native transcript events must be an array");
        }

        List<Integer> rejected = new ArrayList<>();
        JsonArray events = envelope.getAsJsonArray("events");
        for (int index = 0; index < events.size(); index++) {
            try {
                apply(decode(events.get(index)));
            } catch (IllegalArgumentException error) {
                // error-policy:J3 malformed bridge input is explicitly reported
                // by source index while valid siblings continue through the fold.
                rejected.add(index);
            }
        }
        return new ApplyResult(viewModel(), rejected);
    }

    JsonObject viewModel() {
        List<Entry> ordered = new ArrayList<>(entries.values());
        ordered.sort(
            Comparator.comparingLong((Entry entry) -> entry.order)
                .thenComparing(entry -> entry.item.get("id").getAsString())
        );
        JsonArray items = new JsonArray();
        for (Entry entry : ordered) items.add(entry.item.deepCopy());

        JsonObject view = new JsonObject();
        view.add("items", items);
        view.add("speaking", speaking == null ? JsonNull.INSTANCE : speaking.deepCopy());
        view.addProperty("connection", connection);
        view.addProperty("lastSeq", lastSequence);
        return view;
    }

    private static JsonObject decode(JsonElement raw) {
        if (raw == null || !raw.isJsonObject()) invalid("event must be an object");
        JsonObject source = raw.getAsJsonObject();
        String type = requiredString(source, "type");
        long seq = requiredSequence(source);
        if (source.has("at") && !finiteNumber(source.get("at"))) invalid("invalid at");

        JsonObject event = new JsonObject();
        event.addProperty("type", type);
        event.addProperty("seq", seq);
        if (source.has("at")) event.add("at", source.get("at").deepCopy());

        switch (type) {
            case "stt.partial":
                event.addProperty("turnId", requiredNonEmptyString(source, "turnId"));
                event.addProperty("text", requiredString(source, "text"));
                break;
            case "stt.final":
                event.addProperty("turnId", requiredNonEmptyString(source, "turnId"));
                event.addProperty("text", requiredString(source, "text"));
                if (source.has("words")) event.add("words", decodeWords(source.get("words")));
                break;
            case "agent.text":
                event.addProperty("messageId", requiredNonEmptyString(source, "messageId"));
                event.addProperty("text", requiredString(source, "text"));
                event.addProperty("final", requiredBoolean(source, "final"));
                copyOptionalNonEmptyString(source, event, "turnId");
                break;
            case "tool.state": {
                event.addProperty("callId", requiredNonEmptyString(source, "callId"));
                event.addProperty("name", requiredNonEmptyString(source, "name"));
                String phase = requiredString(source, "phase");
                if (!phase.equals("started") && !phase.equals("succeeded") && !phase.equals("failed")) {
                    invalid("invalid tool phase");
                }
                event.addProperty("phase", phase);
                copyOptionalString(source, event, "detail");
                copyOptionalNonEmptyString(source, event, "turnId");
                break;
            }
            case "tts.audio": {
                event.addProperty("utteranceId", requiredNonEmptyString(source, "utteranceId"));
                String phase = requiredString(source, "phase");
                if (!phase.equals("started") && !phase.equals("ended")) invalid("invalid audio phase");
                event.addProperty("phase", phase);
                copyOptionalNonEmptyString(source, event, "messageId");
                break;
            }
            case "cancel": {
                String scope = requiredString(source, "scope");
                if (!scope.equals("turn") && !scope.equals("all")) invalid("invalid cancel scope");
                event.addProperty("scope", scope);
                if (scope.equals("turn")) {
                    event.addProperty("turnId", requiredNonEmptyString(source, "turnId"));
                } else {
                    copyOptionalNonEmptyString(source, event, "turnId");
                }
                copyOptionalString(source, event, "reason");
                break;
            }
            case "error":
                event.addProperty("code", requiredNonEmptyString(source, "code"));
                event.addProperty("retryable", requiredBoolean(source, "retryable"));
                copyOptionalString(source, event, "message");
                break;
            case "reconnect": {
                String phase = requiredString(source, "phase");
                if (!phase.equals("lost") && !phase.equals("restored")) invalid("invalid reconnect phase");
                event.addProperty("phase", phase);
                event.addProperty("attempt", requiredNonNegativeInteger(source, "attempt"));
                break;
            }
            default:
                invalid("unknown event type");
        }
        return event;
    }

    private void apply(JsonObject event) {
        long sequence = event.get("seq").getAsLong();
        if (appliedSequences.contains(sequence)) return;
        appliedSequences.add(sequence);
        lastSequence = Math.max(lastSequence, sequence);

        String type = event.get("type").getAsString();
        switch (type) {
            case "stt.partial": {
                String id = event.get("turnId").getAsString();
                String key = key("user", id);
                Entry previous = entries.get(key);
                if (previous != null && !previous.item.get("status").getAsString().equals("partial")) return;
                upsert(key, sequence, prior -> {
                    JsonObject item = baseItem("user", id, "partial");
                    item.addProperty("text", event.get("text").getAsString());
                    item.add(
                        "words",
                        prior != null && prior.has("words")
                            ? prior.getAsJsonArray("words").deepCopy()
                            : new JsonArray()
                    );
                    return item;
                });
                break;
            }
            case "stt.final": {
                String id = event.get("turnId").getAsString();
                upsert(key("user", id), sequence, prior -> {
                    JsonObject item = baseItem("user", id, "final");
                    item.addProperty("text", event.get("text").getAsString());
                    item.add(
                        "words",
                        event.has("words") ? event.getAsJsonArray("words").deepCopy() : new JsonArray()
                    );
                    return item;
                });
                break;
            }
            case "agent.text": {
                String id = event.get("messageId").getAsString();
                String key = key("agent", id);
                Entry previous = entries.get(key);
                if (
                    previous != null &&
                    previous.item.get("status").getAsString().equals("final") &&
                    !event.get("final").getAsBoolean()
                ) return;
                upsert(key, sequence, prior -> {
                    JsonObject item = baseItem(
                        "agent",
                        id,
                        event.get("final").getAsBoolean() ? "final" : "streaming"
                    );
                    item.addProperty("text", event.get("text").getAsString());
                    copyEventOrPrevious(event, prior, item, "turnId");
                    return item;
                });
                break;
            }
            case "tool.state": {
                String id = event.get("callId").getAsString();
                String key = key("tool", id);
                Entry previous = entries.get(key);
                if (
                    previous != null &&
                    (previous.item.get("status").getAsString().equals("succeeded") ||
                        previous.item.get("status").getAsString().equals("failed")) &&
                    event.get("phase").getAsString().equals("started")
                ) return;
                upsert(key, sequence, prior -> {
                    String phase = event.get("phase").getAsString();
                    String status = phase.equals("started")
                        ? "running"
                        : phase.equals("succeeded") ? "succeeded" : "failed";
                    JsonObject item = baseItem("tool", id, status);
                    item.addProperty("name", event.get("name").getAsString());
                    copyEventOrPrevious(event, prior, item, "detail");
                    copyEventOrPrevious(event, prior, item, "turnId");
                    return item;
                });
                break;
            }
            case "tts.audio": {
                String utteranceId = event.get("utteranceId").getAsString();
                if (event.get("phase").getAsString().equals("started")) {
                    speaking = new JsonObject();
                    speaking.addProperty("utteranceId", utteranceId);
                    if (event.has("messageId")) {
                        speaking.addProperty("messageId", event.get("messageId").getAsString());
                    }
                } else if (
                    speaking != null && speaking.get("utteranceId").getAsString().equals(utteranceId)
                ) {
                    speaking = null;
                }
                break;
            }
            case "cancel":
                applyCancel(event, sequence);
                break;
            case "error": {
                String id = "error:" + sequence;
                upsert(id, sequence, prior -> {
                    JsonObject item = new JsonObject();
                    item.addProperty("kind", "error");
                    item.addProperty("id", id);
                    item.addProperty("code", event.get("code").getAsString());
                    item.addProperty("retryable", event.get("retryable").getAsBoolean());
                    if (event.has("message")) item.add("message", event.get("message").deepCopy());
                    return item;
                });
                break;
            }
            case "reconnect": {
                String phase = event.get("phase").getAsString();
                connection = phase.equals("lost") ? "lost" : "live";
                String id = "reconnect:" + sequence;
                upsert(id, sequence, prior -> {
                    JsonObject item = new JsonObject();
                    item.addProperty("kind", "reconnect");
                    item.addProperty("id", id);
                    item.addProperty("phase", phase);
                    item.addProperty("attempt", event.get("attempt").getAsLong());
                    return item;
                });
                break;
            }
            default:
                throw new IllegalStateException("Decoded native transcript type is unsupported");
        }
    }

    private void applyCancel(JsonObject event, long sequence) {
        String scope = event.get("scope").getAsString();
        String turnId = event.has("turnId") ? event.get("turnId").getAsString() : null;
        Set<String> cancelledMessages = new HashSet<>();
        for (Map.Entry<String, Entry> mapEntry : new ArrayList<>(entries.entrySet())) {
            Entry entry = mapEntry.getValue();
            JsonObject item = entry.item;
            if (!isInFlight(item)) continue;
            if (scope.equals("turn") && !belongsToTurn(item, turnId)) continue;
            JsonObject cancelled = item.deepCopy();
            cancelled.addProperty("status", "cancelled");
            if (item.get("kind").getAsString().equals("agent")) {
                cancelledMessages.add(item.get("id").getAsString());
            }
            entries.put(
                mapEntry.getKey(),
                new Entry(cancelled, entry.order, Math.max(entry.revision, sequence))
            );
        }
        if (
            speaking != null &&
            (scope.equals("all") ||
                (speaking.has("messageId") &&
                    cancelledMessages.contains(speaking.get("messageId").getAsString())))
        ) {
            speaking = null;
        }
    }

    private void upsert(String key, long sequence, Function<JsonObject, JsonObject> build) {
        Entry previous = entries.get(key);
        if (previous != null && sequence <= previous.revision) return;
        entries.put(
            key,
            new Entry(build.apply(previous == null ? null : previous.item), previous == null ? sequence : previous.order, sequence)
        );
    }

    private static boolean isInFlight(JsonObject item) {
        String kind = item.get("kind").getAsString();
        String status = item.has("status") ? item.get("status").getAsString() : "";
        return (
            (kind.equals("user") && status.equals("partial")) ||
            (kind.equals("agent") && status.equals("streaming")) ||
            (kind.equals("tool") && status.equals("running"))
        );
    }

    private static boolean belongsToTurn(JsonObject item, String turnId) {
        String kind = item.get("kind").getAsString();
        if (kind.equals("user")) return item.get("id").getAsString().equals(turnId);
        return (
            (kind.equals("agent") || kind.equals("tool")) &&
            item.has("turnId") &&
            item.get("turnId").getAsString().equals(turnId)
        );
    }

    private static JsonObject baseItem(String kind, String id, String status) {
        JsonObject item = new JsonObject();
        item.addProperty("kind", kind);
        item.addProperty("id", id);
        item.addProperty("status", status);
        return item;
    }

    private static void copyEventOrPrevious(
        JsonObject event,
        JsonObject previous,
        JsonObject target,
        String field
    ) {
        if (event.has(field)) target.add(field, event.get(field).deepCopy());
        else if (previous != null && previous.has(field)) target.add(field, previous.get(field).deepCopy());
    }

    private static JsonArray decodeWords(JsonElement raw) {
        if (raw == null || !raw.isJsonArray()) invalid("invalid words");
        JsonArray words = new JsonArray();
        for (JsonElement value : raw.getAsJsonArray()) {
            if (!value.isJsonObject()) invalid("invalid word");
            JsonObject source = value.getAsJsonObject();
            String text = requiredString(source, "text");
            double start = requiredFiniteNumber(source, "startMs");
            double end = requiredFiniteNumber(source, "endMs");
            if (start < 0 || end < start) invalid("invalid word timing");
            JsonObject word = new JsonObject();
            word.addProperty("text", text);
            word.addProperty("startMs", start);
            word.addProperty("endMs", end);
            words.add(word);
        }
        return words;
    }

    private static long requiredSequence(JsonObject source) {
        long value = requiredNonNegativeInteger(source, "seq");
        if (value > 9_007_199_254_740_991L) invalid("unsafe sequence");
        return value;
    }

    private static long requiredNonNegativeInteger(JsonObject source, String field) {
        if (!source.has(field) || !finiteNumber(source.get(field))) invalid("invalid " + field);
        double value = source.get(field).getAsDouble();
        if (value < 0 || Math.rint(value) != value || value > Long.MAX_VALUE) invalid("invalid " + field);
        return (long) value;
    }

    private static double requiredFiniteNumber(JsonObject source, String field) {
        if (!source.has(field) || !finiteNumber(source.get(field))) invalid("invalid " + field);
        return source.get(field).getAsDouble();
    }

    private static boolean finiteNumber(JsonElement value) {
        if (value == null || !value.isJsonPrimitive()) return false;
        JsonPrimitive primitive = value.getAsJsonPrimitive();
        if (!primitive.isNumber()) return false;
        return Double.isFinite(primitive.getAsDouble());
    }

    private static String requiredString(JsonObject source, String field) {
        if (!source.has(field) || !source.get(field).isJsonPrimitive()) invalid("missing " + field);
        JsonPrimitive value = source.get(field).getAsJsonPrimitive();
        if (!value.isString()) invalid("invalid " + field);
        return value.getAsString();
    }

    private static String requiredNonEmptyString(JsonObject source, String field) {
        String value = requiredString(source, field);
        if (value.isEmpty()) invalid("empty " + field);
        return value;
    }

    private static boolean requiredBoolean(JsonObject source, String field) {
        if (!source.has(field) || !source.get(field).isJsonPrimitive()) invalid("missing " + field);
        JsonPrimitive value = source.get(field).getAsJsonPrimitive();
        if (!value.isBoolean()) invalid("invalid " + field);
        return value.getAsBoolean();
    }

    private static void copyOptionalString(JsonObject source, JsonObject target, String field) {
        if (!source.has(field)) return;
        target.addProperty(field, requiredString(source, field));
    }

    private static void copyOptionalNonEmptyString(JsonObject source, JsonObject target, String field) {
        if (!source.has(field)) return;
        target.addProperty(field, requiredNonEmptyString(source, field));
    }

    private static String stringValue(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
            ? value.getAsString()
            : null;
    }

    private static String key(String kind, String id) {
        return kind + ":" + id;
    }

    private static void invalid(String message) {
        throw new IllegalArgumentException(message);
    }
}
