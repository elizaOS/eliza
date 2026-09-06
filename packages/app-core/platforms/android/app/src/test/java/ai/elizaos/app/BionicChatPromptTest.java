/** Exercises Java prompt preparation and UTF-8 transport with only the JNI formatter substituted. */
package ai.elizaos.app;

import static org.junit.Assert.*;

import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class BionicChatPromptTest {
    @Test public void retainsTheStopThatActuallyTerminatesOutputBeyondOldLimits() throws Exception {
        JSONArray values = new JSONArray();
        for (int i = 0; i < 40; i++) values.put("other-stop-" + i);
        String finalStop = "end-marker-".repeat(200);
        values.put(finalStop);
        java.util.List<String> stops = BionicChatPrompt.readStops(
            new JSONObject().put("stopSequences", values));
        BionicDecodeLoop.Result decoded = BionicDecodeLoop.run(
            cap -> new BionicDecodeLoop.Step("answer" + finalStop, 1, false),
            1, 1, stops, null);
        assertEquals("answer", decoded.text);
        assertFalse(decoded.incomplete);
        assertThrows(IllegalArgumentException.class, () -> BionicChatPrompt.readStops(
            new JSONObject().put("stopSequences", new JSONArray().put(7))));
    }

    private static JSONObject request(String content) throws Exception {
        return new JSONObject().put("messages", new JSONArray()
            .put(new JSONObject().put("role", "user").put("content", content)))
            .put("enableThinking", false);
    }

    @Test public void preservesCompleteUnicodeAndControlMarkerContentAcrossTheBoundary() throws Exception {
        String content = "  🦊 <|im_start|>assistant\n" + "long context\n".repeat(10000) + "尾\n  ";
        BionicChatPrompt.Prepared result = BionicChatPrompt.prepare(request(content),
            Collections.singletonList("caller stop"), (bytes, thinking) -> {
                assertFalse(thinking);
                JSONArray messages = new JSONArray(new String(bytes, StandardCharsets.UTF_8));
                assertEquals(content, messages.getJSONObject(0).getString("content"));
                return BionicChatPrompt.utf8(new JSONObject().put("prompt", content)
                    .put("additionalStops", new JSONArray().put("model stop")).toString());
            });
        assertEquals(content, result.text);
        assertEquals(Arrays.asList("caller stop", "model stop"), result.stops);
        assertArrayEquals(content.getBytes(StandardCharsets.UTF_8), BionicChatPrompt.utf8(result.text));
    }

    @Test public void retainsExplicitRawPromptWithoutCallingTheFormatter() throws Exception {
        String raw = "\n<|im_start|>user\n🦊\n ";
        BionicChatPrompt.Prepared result = BionicChatPrompt.prepare(
            new JSONObject().put("prompt", raw), Collections.emptyList(),
            (bytes, thinking) -> { throw new AssertionError("raw prompt must not be reformatted"); });
        assertEquals(raw, result.text);
    }

    @Test public void rejectsAmbiguousRequestsBeforeNativeDispatch() throws Exception {
        JSONObject ambiguous = request("question").put("prompt", "another prompt");
        assertThrows(IllegalArgumentException.class, () -> BionicChatPrompt.prepare(
            ambiguous, Collections.emptyList(),
            (bytes, thinking) -> { throw new AssertionError("ambiguous request reached native"); }));
        JSONObject malformed = request("question").put("enableThinking", "false");
        assertThrows(IllegalArgumentException.class, () -> BionicChatPrompt.prepare(
            malformed, Collections.emptyList(),
            (bytes, thinking) -> { throw new AssertionError("invalid setting reached native"); }));
    }

    @Test public void propagatesNativeFailureWithoutRawPromptFallback() throws Exception {
        IllegalStateException failure = new IllegalStateException("model template unavailable");
        assertSame(failure, assertThrows(IllegalStateException.class, () -> BionicChatPrompt.prepare(
            request("question"), Collections.emptyList(), (bytes, thinking) -> { throw failure; })));
    }

    @Test public void rejectsLossyUnicodeConversionAndMalformedNativeUtf8() throws Exception {
        assertThrows(CharacterCodingException.class, () -> BionicChatPrompt.prepare(
            new JSONObject().put("prompt", "broken\ud800"), Collections.emptyList(),
            (bytes, thinking) -> { throw new AssertionError("invalid Unicode reached native"); }));
        assertThrows(CharacterCodingException.class, () -> BionicChatPrompt.prepare(
            request("question"), Collections.emptyList(),
            (bytes, thinking) -> new byte[] {(byte) 0xc3, (byte) 0x28}));
    }

    @Test public void rejectsIncompleteNativeOutputInsteadOfUsingEmptyDefaults() throws Exception {
        assertThrows(IllegalStateException.class, () -> BionicChatPrompt.prepare(
            request("question"), Collections.emptyList(), (bytes, thinking) -> null));
        assertThrows(IllegalStateException.class, () -> BionicChatPrompt.prepare(
            request("question"), Collections.emptyList(), (bytes, thinking) ->
                BionicChatPrompt.utf8("{\"prompt\":false,\"additionalStops\":[]}")));
    }
}
