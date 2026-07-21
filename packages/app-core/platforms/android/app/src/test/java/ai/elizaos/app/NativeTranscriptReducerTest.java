/**
 * Runs Android's independent decoder/reducer through the exact shared golden
 * fixture, including every malformed, ordering, cancellation, and Unicode case.
 */

package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class NativeTranscriptReducerTest {
    @Test
    public void sharedGoldenFixtureConformsOnAndroid() {
        InputStream stream = getClass().getResourceAsStream("/native-transcript-golden.json");
        assertNotNull("shared native transcript fixture must be on the test classpath", stream);
        JsonObject fixture = JsonParser.parseReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8)
        ).getAsJsonObject();

        for (var scenarioValue : fixture.getAsJsonArray("scenarios")) {
            JsonObject scenario = scenarioValue.getAsJsonObject();
            NativeTranscriptReducer reducer = new NativeTranscriptReducer();
            JsonObject envelope = new JsonObject();
            envelope.add("schema", fixture.get("schema").deepCopy());
            envelope.add("events", scenario.getAsJsonArray("events").deepCopy());

            NativeTranscriptReducer.ApplyResult result = reducer.applyEnvelope(envelope);
            assertEquals(
                scenario.get("name").getAsString() + " rejected indexes",
                integerList(scenario.getAsJsonArray("expectRejectedIndexes")),
                result.rejectedIndexes
            );
            assertEquals(
                scenario.get("name").getAsString() + " view model",
                scenario.getAsJsonObject("expectView"),
                result.view
            );
        }
    }

    @Test
    public void appendOnlyBatchesShareNativeState() {
        NativeTranscriptReducer reducer = new NativeTranscriptReducer();
        reducer.applyEnvelope(envelope(
            "{\"type\":\"stt.partial\",\"seq\":1,\"turnId\":\"t\",\"text\":\"hel\"}"
        ));
        NativeTranscriptReducer.ApplyResult result = reducer.applyEnvelope(envelope(
            "{\"type\":\"stt.final\",\"seq\":2,\"turnId\":\"t\",\"text\":\"hello\"}"
        ));
        assertEquals("final", result.view.getAsJsonArray("items")
            .get(0).getAsJsonObject().get("status").getAsString());
        assertEquals(2, result.view.get("lastSeq").getAsInt());
    }

    private static JsonObject envelope(String eventJson) {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("schema", NativeTranscriptReducer.SCHEMA);
        JsonArray events = new JsonArray();
        events.add(JsonParser.parseString(eventJson));
        envelope.add("events", events);
        return envelope;
    }

    private static List<Integer> integerList(JsonArray values) {
        List<Integer> result = new ArrayList<>();
        for (var value : values) result.add(value.getAsInt());
        return result;
    }
}
