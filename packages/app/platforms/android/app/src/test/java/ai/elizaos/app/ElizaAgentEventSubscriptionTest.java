/**
 * Host-side coverage for the private-IPC agent-event feed
 * ({@code events_subscribe}): request validation and frame translation.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class ElizaAgentEventSubscriptionTest {

    @Test
    public void payloadRequiresBoundedValidFilterAndCarriesBearer() throws JSONException {
        JSONObject payload = ElizaAgentService.buildEventSubscriptionPayload(
            "{\"streams\":[\"voice-transcript\",\"voice-transcript\",\"assistant\"]}", " tok ");
        assertEquals(2, payload.getJSONArray("streams").length());
        assertEquals("voice-transcript", payload.getJSONArray("streams").getString(0));
        assertEquals("Bearer tok", payload.getJSONObject("headers").getString("Authorization"));

        JSONObject anonymous = ElizaAgentService.buildEventSubscriptionPayload(
            "{\"streams\":[\"voice-transcript\"]}", null);
        assertFalse(anonymous.getJSONObject("headers").has("Authorization"));

        StringBuilder many = new StringBuilder("{\"streams\":[");
        for (int i = 0; i < 17; i++) many.append(i == 0 ? "" : ",").append("\"s").append(i).append('"');
        many.append("]}");
        for (String invalid : new String[] {
            null, "{}", "{\"streams\":[]}", "{\"streams\":[\"*\"]}", "{\"streams\":[\"Bad Name\"]}",
            "{\"streams\":[1]}", many.toString(),
        }) {
            try {
                ElizaAgentService.buildEventSubscriptionPayload(invalid, "tok");
                fail("accepted invalid filter " + invalid);
            } catch (IllegalArgumentException expected) {
                // refused before any socket is opened
            }
        }
    }

    @Test
    public void framesTranslateToCallerEnvelopes() throws JSONException {
        JSONObject ack = ElizaAgentService.translateEventSubscriptionFrame(
            "{\"id\":1,\"event\":\"subscribed\",\"streams\":[\"voice-transcript\"]}");
        assertEquals("subscribed", ack.getString("type"));
        assertEquals("voice-transcript", ack.getJSONArray("streams").getString(0));

        JSONObject event = ElizaAgentService.translateEventSubscriptionFrame(
            "{\"id\":1,\"event\":\"agent_event\",\"data\":{\"type\":\"agent_event\",\"version\":1,"
                + "\"eventId\":\"eph-3\",\"ephemeral\":true,\"stream\":\"voice-transcript\","
                + "\"payload\":{\"phase\":\"partial\",\"text\":\"hi\",\"seq\":1}}}");
        assertEquals("event", event.getString("type"));
        assertTrue(event.getJSONObject("event").getBoolean("ephemeral"));
        assertEquals("partial", event.getJSONObject("event").getJSONObject("payload").getString("phase"));

        JSONObject dropped = ElizaAgentService.translateEventSubscriptionFrame(
            "{\"id\":1,\"event\":\"dropped\",\"count\":2}");
        assertEquals(2, dropped.getInt("count"));

        JSONObject refused = ElizaAgentService.translateEventSubscriptionFrame(
            "{\"id\":1,\"event\":\"error\",\"error\":\"Unauthorized\"}");
        assertEquals("end", refused.getString("type"));
        assertEquals("Unauthorized", refused.getString("error"));

        assertNull(ElizaAgentService.translateEventSubscriptionFrame("{\"id\":1,\"event\":\"keepalive\"}"));
        assertNull(ElizaAgentService.translateEventSubscriptionFrame("{\"id\":1,\"event\":\"future\"}"));
        try {
            ElizaAgentService.translateEventSubscriptionFrame(
                "{\"id\":1,\"event\":\"agent_event\",\"data\":{\"type\":\"other\"}}");
            fail("accepted a non agent_event envelope");
        } catch (JSONException expected) {
            // malformed envelopes end the feed
        }
    }

    @Test
    public void idleBudgetOutlastsAgentKeepalive() {
        assertTrue(ElizaAgentService.LOCAL_EVENT_IDLE_TIMEOUT_MS >= 3 * 15_000);
    }
}
