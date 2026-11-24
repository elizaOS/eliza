// spec/localInference/speechOutput.md, "Story: Speak a reply without cutting off what is playing"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class SpeechRequestGateTest {
  @Test public void appendedSentencesWaitBehindTheRunningOneABoundedFewAndAPlainRequestNeverQueues() {
    SpeechRequestGate gate = new SpeechRequestGate();
    SpeechRequestGate.Request a = gate.admit("a", true, true).request;
    assertNotNull(a);
    assertNull(gate.admit("x", true).request);
    assertEquals(SpeechRequestGate.Refusal.BUSY, gate.admit("x", false).refusal);
    SpeechRequestGate.Request b = gate.admit("b", true, true).request;
    assertNotNull(b);
    assertEquals(SpeechRequestGate.Refusal.UNAVAILABLE, gate.admit("b", true, true).refusal);
    SpeechRequestGate.Request c = gate.admit("c", true, true).request;
    assertNotNull(c);
    assertEquals(SpeechRequestGate.Refusal.BUSY, gate.admit("d", true, true).refusal);
    gate.settle(a);
    assertNotNull(gate.admit("d", true, true).request);
    gate.cancelAll();
    assertTrue(b.cancelled);
    assertTrue(c.cancelled);
    gate.destroy();
    assertNull(gate.admit("e", true, true).request);
  }
}
