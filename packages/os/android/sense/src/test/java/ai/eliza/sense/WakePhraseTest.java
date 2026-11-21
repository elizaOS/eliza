// spec/os/voice/listener.md, "Wake audio never leaves the device and opens only the assistant, while unlocked"
package ai.eliza.sense;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class WakePhraseTest {
  private static final String NAME = "eliza";

  private static WakePhrase.Action heard(String transcript) { return WakePhrase.classify(transcript, NAME); }

  private static short[] tone(double amplitude, int frame) {
    short[] out = new short[SpeechGate.FRAME_SAMPLES];
    for (int i = 0; i < out.length; i++)
      out[i] = (short) Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * 220 * (frame * out.length + i) / SpeechGate.SAMPLE_RATE));
    return out;
  }

  @Test public void onlyAnUtteranceThatStartsWithTheNameIsActedOn() {
    assertEquals(WakePhrase.Action.INVOKE, heard("Eliza, what's on my calendar?"));
    assertEquals(WakePhrase.Action.INVOKE, heard("hey eliza"));
    assertEquals(WakePhrase.Action.INVOKE, heard("OK ELIZA."));
    assertEquals(WakePhrase.Action.PAUSE_LISTENING, heard("Eliza, stop listening."));
    assertEquals(WakePhrase.Action.PAUSE_LISTENING, heard("hey eliza pause"));
    assertEquals(WakePhrase.Action.INVOKE, heard("Eliza stop listening to the radio"));
    for (String other : new String[] {"", "   ", null, "the eliza version is out", "I told eliza", "elizabeth", "hey", "hey hey eliza", "stop listening",
        "eliza " + "word ".repeat(80)})
      assertEquals(String.valueOf(other), WakePhrase.Action.IGNORE, heard(other));
  }

  @Test public void theWakeNameOpensTheAssistantOnlyWhileUnlocked() {
    assertFalse(ListenerPolicy.mayInvokeAssistant(true));
    assertTrue(ListenerPolicy.mayInvokeAssistant(false));
  }

  @Test public void theSpeechGateHandsOnOnlyBoundedUtterancesKeptInMemory() {
    List<float[]> out = new ArrayList<>();
    SpeechGate gate = new SpeechGate(out::add);
    int frame = 0;
    for (int i = 0; i < 100; i++) gate.accept(tone(0.0005, frame++));
    assertTrue(out.isEmpty());
    for (int i = 0; i < 5; i++) gate.accept(tone(0.3, frame++));
    for (int i = 0; i < 60; i++) gate.accept(tone(0.0005, frame++));
    assertTrue(out.isEmpty());
    for (int i = 0; i < 50; i++) gate.accept(tone(0.3, frame++));
    for (int i = 0; i < SpeechGate.HANGOVER_FRAMES; i++) gate.accept(tone(0.0005, frame++));
    assertEquals(1, out.size());
    int samples = out.get(0).length;
    assertTrue(samples >= 50 * SpeechGate.FRAME_SAMPLES && samples <= (50 + SpeechGate.PREROLL_FRAMES + 1) * SpeechGate.FRAME_SAMPLES);
    out.clear();
    for (int i = 0; i < SpeechGate.MAX_FRAMES + 50; i++) gate.accept(tone(0.3, frame++));
    assertTrue(out.size() == 1 && out.get(0).length <= SpeechGate.MAX_FRAMES * SpeechGate.FRAME_SAMPLES);
    out.clear();
    gate.reset();
    for (int i = 0; i < 30; i++) gate.accept(tone(0.3, frame++));
    gate.reset();
    for (int i = 0; i < SpeechGate.HANGOVER_FRAMES + 5; i++) gate.accept(new short[SpeechGate.FRAME_SAMPLES]);
    assertTrue(out.isEmpty());
  }

  @Test public void theNoiseFloorAdaptsSoSteadyNoiseStopsCountingAsSpeech() {
    List<float[]> out = new ArrayList<>();
    SpeechGate adaptive = new SpeechGate(out::add);
    for (int i = 0; i < 2000; i++) adaptive.accept(tone(0.0005, i));
    assertTrue(adaptive.noiseFloorDb() < -60);
    for (int i = 0; i < 20_000; i++) adaptive.accept(tone(0.05, i));
    assertTrue(adaptive.noiseFloorDb() > -40);
    int before = out.size();
    for (int i = 0; i < 2000; i++) adaptive.accept(tone(0.05, i));
    assertEquals(before, out.size());
    boolean refused = false;
    try {
      adaptive.accept(new short[10]);
    } catch (IllegalArgumentException expected) {
      refused = true;
    }
    assertTrue(refused);
    assertEquals(-120.0, SpeechGate.levelDbfs(new short[SpeechGate.FRAME_SAMPLES], 0, SpeechGate.FRAME_SAMPLES), 0);
  }
}
