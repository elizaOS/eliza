// spec/os/agentService/inference.md, "Story: Embed, speak and transcribe on my phone through my app alone"
package ai.eliza.voice;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class SpeechEngineHoldTest {
  @Test public void aConversationHoldsTheSpeechEngineOnlyInTheForegroundAndTwoHoldsAreOne() {
    SpeechEngineHold hold = new SpeechEngineHold();
    assertFalse(hold.keeps(true));
    assertFalse(hold.release());
    hold.hold();
    hold.hold();
    assertTrue(hold.keeps(true));
    assertFalse(hold.keeps(false));
    assertTrue(hold.release());
    assertFalse(hold.release());
    assertFalse(hold.keeps(true));
  }
}
