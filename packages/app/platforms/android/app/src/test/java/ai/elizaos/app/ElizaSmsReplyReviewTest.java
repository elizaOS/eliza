/**
 * Host-side coverage for the SMS gateway's reviewed replies: an incoming text with a Cloud reply sends
 * nothing without the owner's review decision. Fakes only: no SIM, radio, provider or Cloud call.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class ElizaSmsReplyReviewTest {
    private static final long NOW = 1_800_000_000_000L;

    /** In-memory storage of the proposal store. */
    private static final class Memory implements ElizaSmsReplyProposals.Storage {
        String value;
        @Override public String read() { return value; }
        @Override public void write(String next) { value = next; }
    }

    /** A Cloud that answers with a fixed reply and records what it was sent. */
    private static final class FakeCloud implements ElizaSmsGatewayFlow.Cloud {
        final List<JSONObject> posted = new ArrayList<>();
        final JSONObject answer;
        FakeCloud(JSONObject answer) { this.answer = answer; }
        @Override public JSONObject post(JSONObject payload) {
            posted.add(payload);
            return answer;
        }
    }

    /**
     * Stands in for the radio. The gateway flow is never given it: the only path to it is the owner's
     * Send in the review screen, which these tests model as an explicit decision.
     */
    private static final class FakeRadio {
        final List<String> sends = new ArrayList<>();
        void send(ElizaSmsReplyProposals.Proposal reviewed) { sends.add(reviewed.operationId + ":" + reviewed.recipient + ":" + reviewed.body); }
    }

    private static ElizaSmsGatewayFlow.Inbound inbound(String sender, int subscription) {
        return new ElizaSmsGatewayFlow.Inbound(sender, "are you free tonight?", NOW - 5000, "42", subscription);
    }

    private static JSONObject reply(String text) throws Exception {
        return new JSONObject().put("replyText", text);
    }

    @Test
    public void cloudReplyBecomesAPendingProposalAndSendsNothing() throws Exception {
        Memory memory = new Memory();
        ElizaSmsReplyProposals proposals = new ElizaSmsReplyProposals(memory);
        FakeCloud cloud = new FakeCloud(reply("  Yes, after 7.  "));
        FakeRadio radio = new FakeRadio();

        ElizaSmsGatewayFlow.Result result = ElizaSmsGatewayFlow.forward(
                inbound("+1 (555) 555-0100", 3), "+14155550000", "Gateway", 0, cloud,
                proposal -> proposals.add(proposal, NOW), NOW);

        assertEquals(1, cloud.posted.size());
        assertNotNull(result.proposal);
        assertTrue("nothing reaches the radio without a review decision", radio.sends.isEmpty());
        List<ElizaSmsReplyProposals.Proposal> pending = proposals.pending(NOW);
        assertEquals(1, pending.size());
        ElizaSmsReplyProposals.Proposal proposal = pending.get(0);
        // The exact sms.send.v1 operation the owner reviews: normalized sender, trimmed reply, arrival SIM.
        JSONObject operation = proposal.operation();
        assertEquals("sms_send", operation.getString("type"));
        assertEquals("+15555550100", operation.getJSONArray("recipients").getString(0));
        assertEquals(1, operation.getJSONArray("recipients").length());
        assertEquals("Yes, after 7.", operation.getString("body"));
        assertEquals(3, operation.getInt("subscriptionId"));
        assertEquals(4, operation.length());
        assertTrue(proposal.operationId.matches("^sms-reply-[0-9a-f]{40}$"));

        // The draft survives a process restart (the store is durable) and still has not been sent.
        ElizaSmsReplyProposals reloaded = new ElizaSmsReplyProposals(memory);
        assertEquals(proposal.body, reloaded.get(proposal.operationId, NOW + 60_000).body);
        assertTrue(radio.sends.isEmpty());

        // Only the owner's Send decision reaches the radio, once, with exactly the reviewed operation.
        ElizaSmsReplyProposals.Proposal reviewed = reloaded.get(proposal.operationId, NOW + 60_000);
        radio.send(reviewed);
        assertTrue(reloaded.remove(reviewed.operationId));
        assertEquals(1, radio.sends.size());
        assertEquals(proposal.operationId + ":+15555550100:Yes, after 7.", radio.sends.get(0));
        assertNull(reloaded.get(proposal.operationId, NOW + 60_000));
    }

    @Test
    public void discardedProposalNeverSends() throws Exception {
        ElizaSmsReplyProposals proposals = new ElizaSmsReplyProposals(new Memory());
        FakeRadio radio = new FakeRadio();
        ElizaSmsGatewayFlow.Result result = ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", 1), "+14155550000", "Gateway", 0, new FakeCloud(reply("Sure")),
                proposal -> proposals.add(proposal, NOW), NOW);
        assertTrue(proposals.remove(result.proposal.operationId));
        assertFalse("a decided draft is gone", proposals.remove(result.proposal.operationId));
        assertTrue(proposals.pending(NOW).isEmpty());
        assertTrue(radio.sends.isEmpty());
    }

    @Test
    public void retriedWorkerProposesTheSameOperationOnce() throws Exception {
        ElizaSmsReplyProposals proposals = new ElizaSmsReplyProposals(new Memory());
        ElizaSmsGatewayFlow.Result first = ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", 1), "+14155550000", "Gateway", 0, new FakeCloud(reply("First draft")),
                proposal -> proposals.add(proposal, NOW), NOW);
        // WorkManager retries the same input; Cloud may draft differently the second time.
        ElizaSmsGatewayFlow.Result second = ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", 1), "+14155550000", "Gateway", 0, new FakeCloud(reply("Second draft")),
                proposal -> proposals.add(proposal, NOW + 1000), NOW + 1000);
        assertEquals(first.proposal.operationId, second.proposal.operationId);
        List<ElizaSmsReplyProposals.Proposal> pending = proposals.pending(NOW + 1000);
        assertEquals(1, pending.size());
        assertEquals("the owner reviews the draft that was shown first", "First draft", pending.get(0).body);
        // A different incoming message is a different operation.
        ElizaSmsGatewayFlow.Inbound other = new ElizaSmsGatewayFlow.Inbound("+15555550100", "and tomorrow?", NOW, "43", 1);
        ElizaSmsGatewayFlow.Result third = ElizaSmsGatewayFlow.forward(
                other, "+14155550000", "Gateway", 0, new FakeCloud(reply("Maybe")),
                proposal -> proposals.add(proposal, NOW), NOW);
        assertFalse(third.proposal.operationId.equals(first.proposal.operationId));
    }

    @Test
    public void repliesThatCannotBeReviewedAsSmsAreNotProposed() throws Exception {
        ElizaSmsReplyProposals proposals = new ElizaSmsReplyProposals(new Memory());
        ElizaSmsGatewayFlow.Review review = proposal -> proposals.add(proposal, NOW);

        assertEquals(ElizaSmsGatewayFlow.Skipped.NO_REPLY, ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", 1), "+1", "Gateway", 0, new FakeCloud(new JSONObject()), review, NOW).skipped);
        assertEquals(ElizaSmsGatewayFlow.Skipped.NO_REPLY, ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", 1), "+1", "Gateway", 0, new FakeCloud(reply("   ")), review, NOW).skipped);
        assertEquals(ElizaSmsGatewayFlow.Skipped.NO_REPLY_ADDRESS, ElizaSmsGatewayFlow.forward(
                inbound("BANK", 1), "+1", "Gateway", 0, new FakeCloud(reply("ok")), review, NOW).skipped);
        assertEquals(ElizaSmsGatewayFlow.Skipped.NO_SUBSCRIPTION, ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", -1), "+1", "Gateway", -1, new FakeCloud(reply("ok")), review, NOW).skipped);
        StringBuilder tooLong = new StringBuilder();
        for (int i = 0; i < 1601; i++) tooLong.append('x');
        assertEquals("a draft is never shortened behind the owner's back", ElizaSmsGatewayFlow.Skipped.INVALID_REPLY,
                ElizaSmsGatewayFlow.forward(inbound("+15555550100", 1), "+1", "Gateway", 0,
                        new FakeCloud(reply(tooLong.toString())), review, NOW).skipped);
        assertTrue(proposals.pending(NOW).isEmpty());

        // Work queued by an earlier release carries no SIM: the reply is proposed on the default SMS SIM.
        ElizaSmsGatewayFlow.Result legacy = ElizaSmsGatewayFlow.forward(
                inbound("+15555550100", -1), "+1", "Gateway", 2, new FakeCloud(reply("ok")), review, NOW);
        assertEquals(2, legacy.proposal.subscriptionId);
    }

    @Test
    public void cloudFailureProposesNothingAndPropagatesForRetry() throws Exception {
        ElizaSmsReplyProposals proposals = new ElizaSmsReplyProposals(new Memory());
        try {
            ElizaSmsGatewayFlow.forward(inbound("+15555550100", 1), "+1", "Gateway", 0,
                    payload -> { throw new IllegalStateException("Cloud gateway failed (503)"); },
                    proposal -> proposals.add(proposal, NOW), NOW);
            fail("Cloud failure swallowed");
        } catch (IllegalStateException expected) {
            // The worker retries; nothing was proposed or sent.
        }
        assertTrue(proposals.pending(NOW).isEmpty());
    }

    @Test
    public void cloudPayloadKeepsItsWireShape() throws Exception {
        FakeCloud cloud = new FakeCloud(new JSONObject());
        ElizaSmsGatewayFlow.forward(inbound("+15555550100", 1), "+14155550000", "Gateway (+14155550000)", 0, cloud, proposal -> fail("no reply"), NOW);
        JSONObject payload = cloud.posted.get(0);
        assertEquals("new-message", payload.getString("type"));
        JSONObject data = payload.getJSONObject("data");
        assertEquals("42", data.getString("guid"));
        assertEquals("are you free tonight?", data.getString("text"));
        assertFalse(data.getBoolean("isFromMe"));
        assertEquals("+15555550100", data.getJSONObject("handle").getString("address"));
        assertEquals("SMS;-;+15555550100", data.getJSONArray("chats").getJSONObject(0).getString("guid"));
        assertEquals("+14155550000", data.getJSONObject("metadata").getString("localPhoneNumber"));
        assertTrue(data.getJSONObject("metadata").getBoolean("androidSmsGateway"));
        // Without a provider row ID the guid falls back to sender and time, as before.
        FakeCloud fallback = new FakeCloud(new JSONObject());
        ElizaSmsGatewayFlow.forward(new ElizaSmsGatewayFlow.Inbound("+15555550100", "hi", 77L, null, 1), "+1", "G", 0, fallback, proposal -> fail("no reply"), NOW);
        assertEquals("android-sms-+15555550100-77", fallback.posted.get(0).getJSONObject("data").getString("guid"));
    }

    @Test
    public void unreviewedDraftsAreKeptUntilTheyExpire() throws Exception {
        ElizaSmsReplyProposals proposals = new ElizaSmsReplyProposals(new Memory());
        for (int i = 0; i < 60; i++) {
            proposals.add(new ElizaSmsReplyProposals.Proposal("sms-reply-" + i, "+15555550100", "draft " + i, 1, "in-" + i, NOW), NOW);
        }
        List<ElizaSmsReplyProposals.Proposal> pending = proposals.pending(NOW);
        assertEquals("no unreviewed draft is dropped because others are waiting", 60, pending.size());
        assertEquals("sms-reply-0", pending.get(0).operationId);
        assertTrue("a week-old draft is dropped unsent", proposals.pending(NOW + ElizaSmsReplyProposals.MAX_AGE_MS + 1).isEmpty());
    }

    @Test
    public void quickReplyRecipientsAreAllOrNothing() {
        assertArrayEquals(new String[] { "+15555550100" }, ElizaSmsReplyProposals.recipients("+1 555-555-0100"));
        assertArrayEquals(new String[] { "+15555550100", "5550101" }, ElizaSmsReplyProposals.recipients("+15555550100;5550101,+15555550100?body=x"));
        assertNull("a partial recipient list is never sent", ElizaSmsReplyProposals.recipients("+15555550100,BANK"));
        assertNull(ElizaSmsReplyProposals.recipients("*#06#"));
        assertNull(ElizaSmsReplyProposals.recipients(""));
        assertNull(ElizaSmsReplyProposals.recipients(null));
        assertNull(ElizaSmsReplyProposals.recipients("1111,2222,3333,4444,5555,6666"));
    }

    /** The two services that used to send directly now have no radio or sent-box path of their own. */
    @Test
    public void servicesNoLongerSendOrWriteSentRowsDirectly() throws Exception {
        for (String name : new String[] { "ElizaSmsGatewayService", "ElizaRespondViaMessageService", "ElizaSmsGatewayFlow", "ElizaSmsReplyProposals" }) {
            File source = new File("src/main/java/ai/elizaos/app/" + name + ".java");
            assertTrue(source + " exists", source.isFile());
            String text = new String(Files.readAllBytes(source.toPath()), StandardCharsets.UTF_8);
            for (String forbidden : new String[] { "SmsManager", "sendTextMessage", "sendMultipartTextMessage", "Telephony.Sms.Sent", "MESSAGE_TYPE_SENT" }) {
                assertFalse(name + " must not use " + forbidden, text.contains(forbidden));
            }
        }
    }
}
