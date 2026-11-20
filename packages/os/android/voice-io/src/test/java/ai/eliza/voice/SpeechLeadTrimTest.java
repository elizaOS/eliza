// spec/os/voice/speechOutput.md, "The silent lead of an utterance is dropped, keeping a short pre-roll"
package ai.eliza.voice;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

import java.util.Arrays;
import org.junit.Test;

public class SpeechLeadTrimTest {
  private static float[] fill(int n, float value) {
    float[] out = new float[n];
    Arrays.fill(out, value);
    return out;
  }

  @Test public void silentLeadIsDroppedKeepingThePreRollAndLaterAudioPassesThrough() {
    SpeechLeadTrim trim = new SpeechLeadTrim(0.01f, 4);
    float[] silent = fill(10, 0.001f);
    assertEquals(0, trim.next(silent).length);
    assertEquals(0f, silent[9], 0f);
    float[] loud = new float[6];
    loud[3] = 0.5f;
    loud[4] = 0.4f;
    loud[5] = 0.3f;
    float[] first = trim.next(loud);
    assertArrayEquals(new float[] {0.001f, 0f, 0f, 0f, 0.5f, 0.4f, 0.3f}, first, 0f);
    float[] later = fill(5, 0.002f);
    assertSame(later, trim.next(later));
  }

  @Test public void anUtteranceThatStartsLoudIsNotTrimmed() {
    float[] onset = fill(3, 0.2f);
    assertEquals(3, new SpeechLeadTrim(0.01f, 4).next(onset).length);
  }

  @Test public void anOnsetLaterThanThePreRollKeepsExactlyThePreRoll() {
    float[] samples = new float[20];
    samples[12] = 0.6f;
    float[] out = new SpeechLeadTrim(0.01f, 4).next(samples);
    assertEquals(20 - 8, out.length);
    assertEquals(0.6f, out[4], 0f);
  }

  @Test public void anUtteranceThatNeverBecomesAudiblePlaysNothing() {
    SpeechLeadTrim trim = new SpeechLeadTrim(0.01f, 4);
    assertEquals(0, trim.next(fill(8, 0.001f)).length);
    assertEquals(0, trim.next(fill(8, 0f)).length);
  }

  @Test public void thePreRollIsAboutThirtyMilliseconds() {
    assertEquals(720, SpeechLeadTrim.preRollSamples(24_000));
  }
}
