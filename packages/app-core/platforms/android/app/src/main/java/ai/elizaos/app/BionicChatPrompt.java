/**
 * Prepares complete native chat inputs without guessing a model family.
 * Structured requests are formatted by the loaded model; explicitly raw prompts
 * retain their existing transport contract. Unicode conversion rejects loss.
 */
package ai.elizaos.app;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

final class BionicChatPrompt {
    interface Formatter {
        byte[] format(byte[] messagesJson, boolean enableThinking) throws Exception;
    }

    static final class Prepared {
        final String text;
        final List<String> stops;

        Prepared(String text, List<String> stops) {
            this.text = text;
            this.stops = stops;
        }
    }

    static byte[] utf8(String text) throws CharacterCodingException {
        ByteBuffer bytes = StandardCharsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(text));
        byte[] result = new byte[bytes.remaining()];
        bytes.get(result);
        return result;
    }

    static Prepared prepare(JSONObject request, List<String> requestedStops,
                            Formatter formatter) throws Exception {
        if (!request.has("messages")) {
            Object raw = request.opt("prompt");
            if (!(raw instanceof String) || ((String) raw).isEmpty()) {
                throw new IllegalArgumentException("A complete prompt or structured messages is required");
            }
            utf8((String) raw);
            return new Prepared((String) raw, new ArrayList<>(requestedStops));
        }
        if (request.has("prompt")) {
            throw new IllegalArgumentException("Structured messages and a raw prompt cannot be combined");
        }
        JSONArray messages = request.getJSONArray("messages");
        Object thinking = request.opt("enableThinking");
        if (!(thinking instanceof Boolean)) {
            throw new IllegalArgumentException("Structured messages require a boolean enableThinking");
        }
        byte[] formatted = formatter.format(utf8(messages.toString()), (Boolean) thinking);
        if (formatted == null) throw new IllegalStateException("Native chat formatting returned no result");
        String json = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(formatted)).toString();
        JSONObject result = new JSONObject(json);
        Object prompt = result.get("prompt");
        if (!(prompt instanceof String) || ((String) prompt).isEmpty()) {
            throw new IllegalStateException("Native chat formatting returned no complete prompt");
        }
        List<String> stops = new ArrayList<>(requestedStops);
        JSONArray additional = result.getJSONArray("additionalStops");
        for (int i = 0; i < additional.length(); i++) {
            Object value = additional.get(i);
            if (!(value instanceof String) || ((String) value).isEmpty()) {
                throw new IllegalStateException("Native chat formatting returned an invalid stop sequence");
            }
            if (!stops.contains(value)) stops.add((String) value);
        }
        return new Prepared((String) prompt, stops);
    }

    static List<String> readStops(JSONObject request) throws org.json.JSONException {
        if (request.has("stopSequences") && request.has("stop")) {
            throw new IllegalArgumentException("Only one stop-sequence field may be supplied");
        }
        List<String> stops = new ArrayList<>();
        if (!request.has("stopSequences") && !request.has("stop")) return stops;
        JSONArray values = request.getJSONArray(request.has("stopSequences") ? "stopSequences" : "stop");
        for (int i = 0; i < values.length(); i++) {
            Object value = values.get(i);
            if (!(value instanceof String) || ((String) value).isEmpty()) {
                throw new IllegalArgumentException("Every stop sequence must be a nonempty string");
            }
            if (!stops.contains(value)) stops.add((String) value);
        }
        return stops;
    }

    private BionicChatPrompt() {}
}
