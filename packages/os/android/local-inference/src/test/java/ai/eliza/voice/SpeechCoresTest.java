// spec/os/agentService/inference.md, "Story: Embed, speak and transcribe on my phone through my app alone"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.stream.LongStream;
import org.junit.Test;

public final class SpeechCoresTest {
  private static final long LITTLE = 1704000;
  private static final long MID = 2367000;
  private static final long PRIME = 2914000;

  @Test public void aSysfsFrequencyIsKilohertzAndAnythingElseIsUnknown() {
    assertEquals(2914000, SpeechCores.frequency("2914000\n"));
    assertEquals(1704000, SpeechCores.frequency(" 1704000 "));
    assertEquals(0, SpeechCores.frequency(""));
    assertEquals(0, SpeechCores.frequency("fast"));
    assertEquals(0, SpeechCores.frequency("-5"));
    assertEquals(0, SpeechCores.frequency("0"));
  }

  @Test public void speechRunsOnTheBigCoresBetweenTwoAndEightThreads() {
    assertEquals(5, SpeechCores.threads(new long[] {LITTLE, LITTLE, LITTLE, LITTLE, MID, MID, MID, MID, PRIME}, 9));
    assertEquals(4, SpeechCores.threads(new long[] {LITTLE, LITTLE, LITTLE, LITTLE, MID, MID, PRIME, PRIME}, 8));
    assertEquals(2, SpeechCores.threads(new long[] {1800000, 1800000, 1800000, 1800000, 1800000, 1800000, 3000000, 3000000}, 8));
    assertEquals(2, SpeechCores.threads(new long[] {LITTLE, LITTLE, LITTLE, LITTLE, LITTLE, LITTLE, LITTLE, PRIME}, 8));
    assertEquals(6, SpeechCores.threads(new long[] {PRIME, PRIME, PRIME, PRIME, PRIME, PRIME}, 6));
    assertEquals(8, SpeechCores.threads(new long[16], 16));
    assertEquals(8, SpeechCores.threads(LongStream.generate(() -> PRIME).limit(16).toArray(), 16));
    assertEquals(3, SpeechCores.threads(new long[] {0, 0, PRIME, PRIME, PRIME, 0}, 6));
  }

  @Test public void withoutFrequenciesSpeechUsesHalfTheProcessorsAndNeverFewerThanTwo() {
    assertEquals(4, SpeechCores.threads(new long[0], 8));
    assertEquals(3, SpeechCores.threads(new long[] {0, 0}, 6));
    assertEquals(2, SpeechCores.threads(new long[0], 1));
    assertEquals(2, SpeechCores.threads(new long[0], 3));
    int here = SpeechCores.threads();
    assertTrue(here >= SpeechCores.MIN_THREADS && here <= SpeechCores.MAX_THREADS);
  }
}
