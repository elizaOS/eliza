/**
 * Host-side coverage for the incoming-call quick reply: its recipients are all or nothing, and it sends
 * only through the shared reviewed send. Fakes only: no SIM, radio or provider.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class ElizaSmsReplyReviewTest {
    @Test
    public void quickReplyRecipientsAreAllOrNothing() {
        assertArrayEquals(new String[] { "+15555550100" }, ElizaRespondViaMessageService.recipients("+1 555-555-0100"));
        assertArrayEquals(new String[] { "+15555550100", "5550101" }, ElizaRespondViaMessageService.recipients("+15555550100;5550101,+15555550100?body=x"));
        assertNull("a partial recipient list is never sent", ElizaRespondViaMessageService.recipients("+15555550100,BANK"));
        assertNull(ElizaRespondViaMessageService.recipients("*#06#"));
        assertNull(ElizaRespondViaMessageService.recipients(""));
        assertNull(ElizaRespondViaMessageService.recipients(null));
        assertNull(ElizaRespondViaMessageService.recipients("1111,2222,3333,4444,5555,6666"));
    }

    /** The quick reply has no radio or sent-box path of its own. */
    @Test
    public void quickReplyDoesNotSendOrWriteSentRowsDirectly() throws Exception {
        File source = new File("src/main/java/ai/elizaos/app/ElizaRespondViaMessageService.java");
        assertTrue(source + " exists", source.isFile());
        String text = new String(Files.readAllBytes(source.toPath()), StandardCharsets.UTF_8);
        for (String forbidden : new String[] { "SmsManager", "sendTextMessage", "sendMultipartTextMessage", "Telephony.Sms.Sent", "MESSAGE_TYPE_SENT" }) {
            assertFalse("ElizaRespondViaMessageService must not use " + forbidden, text.contains(forbidden));
        }
    }
}
