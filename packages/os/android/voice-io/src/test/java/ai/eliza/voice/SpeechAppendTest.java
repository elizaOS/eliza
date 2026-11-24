// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"; spec/os/voice/speechOutput.md, "A muted speaker keeps the reply playing at no volume, and unmuting restores the volume focus holds"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.Test;

public class SpeechAppendTest {
  private static float[] fill(int n, float value) {
    float[] out = new float[n];
    Arrays.fill(out, value);
    return out;
  }

  private static void until(BooleanSupplier done, String what) throws Exception {
    long end = System.nanoTime() + 2_000_000_000L;
    while (!done.getAsBoolean()) {
      assertTrue(what, System.nanoTime() < end);
      Thread.sleep(2);
    }
  }

  private static final class Out implements StreamingSpeechPlayback.Output {
    final List<Float> heard = new ArrayList<>();
    final AtomicInteger aborts = new AtomicInteger();
    final AtomicInteger stops = new AtomicInteger();
    final AtomicInteger releases = new AtomicInteger();
    final AtomicInteger plays = new AtomicInteger();
    volatile long written;
    volatile long limit = -1;
    volatile float volume = 1f;

    @Override public void play() { plays.incrementAndGet(); }

    @Override
    public synchronized int write(float[] samples, int offset, int length) {
      for (int i = offset; i < offset + length; i++) heard.add(samples[i]);
      written += length;
      return length;
    }

    @Override
    public long playedFrames() {
      long cap = limit;
      return cap < 0 ? written : Math.min(cap, written);
    }

    @Override public long presentationNs(long frame) { return StreamingSpeechPlayback.UNSET; }
    @Override public void setVolume(float gain) { volume = gain; }
    @Override public void abort() { aborts.incrementAndGet(); }
    @Override public void stop() { stops.incrementAndGet(); }
    @Override public void release() { releases.incrementAndGet(); }

    synchronized int count(float value) {
      int n = 0;
      for (float sample : heard) if (sample == value) n++;
      return n;
    }

    synchronized float at(int index) { return heard.get(index); }
  }

  private static final class Events implements StreamingSpeechPlayback.Listener {
    final AtomicInteger first = new AtomicInteger();
    final AtomicInteger ended = new AtomicInteger();
    final AtomicInteger silent = new AtomicInteger();
    final AtomicInteger failed = new AtomicInteger();

    @Override public void firstFrame(long nanos) { first.incrementAndGet(); }
    @Override public void audible(long nanos, String clock) {}

    @Override
    public void ended(boolean wasSilent) {
      if (wasSilent) silent.incrementAndGet();
      ended.incrementAndGet();
    }

    @Override public void failed(String reason) { failed.incrementAndGet(); }
  }

  private static StreamingSpeechPlayback playback(Out out, Events events) {
    return new StreamingSpeechPlayback(48_000, 24_000, .01f, () -> out, events, System::nanoTime);
  }

  @Test public void aSecondSentenceFollowsInTheSameOutputInOrderAndTheUtteranceEndsOnce() throws Exception {
    Out out = new Out();
    Events events = new Events();
    out.limit = 0;
    StreamingSpeechPlayback speech = playback(out, events);
    assertTrue(speech.offer(fill(480, .1f), true));
    speech.start();
    until(() -> out.written == 480, "the first sentence reaches the output");
    assertFalse(speech.audible());
    out.limit = 100;
    assertTrue(speech.audible());
    assertEquals(380, speech.pendingFrames());
    assertFalse(speech.finished());
    assertTrue(speech.extend());
    long[] reached = {-1, -1};
    AtomicInteger marks = new AtomicInteger();
    speech.mark((nanos, buffered) -> {
      marks.incrementAndGet();
      reached[0] = out.written;
      reached[1] = buffered;
    });
    assertTrue(speech.offer(fill(480, .2f), false));
    assertTrue(speech.offer(fill(240, .2f), true));
    until(() -> out.written == 1200, "the second sentence reaches the same output");
    assertEquals(1, marks.get());
    assertEquals(480, reached[0]);
    assertEquals(380, reached[1]);
    assertEquals(0, events.ended.get());
    out.limit = -1;
    assertTrue(speech.join(3000));
    assertEquals(List.of(1, 0, 0, 1), List.of(events.ended.get(), events.silent.get(), events.failed.get(), events.first.get()));
    assertEquals(List.of(1, 1, 1), List.of(out.plays.get(), out.stops.get(), out.releases.get()));
    assertEquals(480, out.count(.1f));
    assertEquals(720, out.count(.2f));
    assertEquals(.1f, out.at(479), 0f);
    assertEquals(.2f, out.at(480), 0f);
    assertTrue(speech.finished());
    assertFalse(speech.extend());
    assertFalse(speech.audible());
  }

  @Test public void aMutedSpeakerKeepsTheReplyPlayingAtNoVolumeAndUnmutingRestoresTheFocusVolume() throws Exception {
    Out out = new Out();
    Events events = new Events();
    out.limit = 0;
    StreamingSpeechPlayback speech = playback(out, events);
    assertTrue(speech.offer(fill(480, .1f), true));
    speech.start();
    until(() -> out.written == 480, "the sentence reaches the output");
    out.limit = 100;
    speech.setOutputMuted(true);
    speech.duck(true);
    assertEquals(0f, out.volume, 0f);
    assertEquals(0, out.aborts.get());
    assertEquals(380, speech.pendingFrames());
    speech.setOutputMuted(false);
    assertEquals(SpeechAudioFocusPolicy.DUCK_VOLUME, out.volume, 0f);
    speech.setOutputMuted(true);
    speech.duck(false);
    assertEquals(0f, out.volume, 0f);
    speech.setOutputMuted(false);
    assertEquals(1f, out.volume, 0f);
    assertEquals(1, out.plays.get());
    out.limit = -1;
    assertTrue(speech.join(3000));
    assertEquals(List.of(1, 0, 0), List.of(events.ended.get(), events.silent.get(), events.failed.get()));
  }

  @Test public void aReservedSentenceKeepsTheUtteranceOpenAndAbandoningItEndsTheUtteranceOnce() throws Exception {
    Out late = new Out();
    Events lateEvents = new Events();
    StreamingSpeechPlayback waiting = playback(late, lateEvents);
    assertTrue(waiting.extend());
    waiting.offer(fill(480, .1f), true);
    waiting.start();
    until(() -> late.written == 480, "the first sentence plays out");
    Thread.sleep(80);
    assertEquals(0, lateEvents.ended.get());
    assertFalse(waiting.finished());
    assertTrue(waiting.offer(fill(480, .3f), false));
    until(() -> late.written == 960, "the late sentence plays");
    assertTrue(waiting.extend());
    assertTrue(waiting.offer(new float[0], true));
    Thread.sleep(40);
    assertEquals(0, lateEvents.ended.get());
    waiting.abandon();
    assertTrue(waiting.join(3000));
    assertEquals(List.of(1, 0, 0), List.of(lateEvents.ended.get(), lateEvents.silent.get(), lateEvents.failed.get()));
    assertEquals(480, late.count(.1f));
    assertEquals(480, late.count(.3f));
    assertEquals(1, late.releases.get());
  }

  @Test public void aSentenceReservedDuringTheDrainAndAbandonedWithoutAudioStillEndsTheUtteranceOnce() throws Exception {
    Out drain = new Out();
    Events drainEvents = new Events();
    drain.limit = 0;
    StreamingSpeechPlayback draining = playback(drain, drainEvents);
    draining.offer(fill(480, .1f), true);
    draining.start();
    until(() -> drain.written == 480, "the sentence is queued");
    assertTrue(draining.extend());
    draining.abandon();
    drain.limit = -1;
    assertTrue(draining.join(3000));
    assertEquals(List.of(1, 0), List.of(drainEvents.ended.get(), drainEvents.failed.get()));
  }

  @Test public void stopDropsEveryQueuedSentenceAndReportsNothing() throws Exception {
    Out cut = new Out();
    Events cutEvents = new Events();
    cut.limit = 0;
    StreamingSpeechPlayback stopped = playback(cut, cutEvents);
    stopped.offer(fill(480, .1f), true);
    stopped.start();
    until(() -> cut.written == 480, "the sentence is queued");
    assertTrue(stopped.extend());
    assertTrue(stopped.offer(fill(24_000, .2f), false));
    assertTrue(stopped.offer(fill(24_000, .2f), false));
    stopped.stop();
    float[] refused = fill(480, .2f);
    assertFalse(stopped.offer(refused, true));
    assertEquals(0f, refused[0], 0f);
    assertFalse(stopped.extend());
    assertFalse(stopped.audible());
    assertEquals(0, stopped.queuedSamples());
    assertTrue(stopped.join(3000));
    assertEquals(List.of(0, 0), List.of(cutEvents.ended.get(), cutEvents.failed.get()));
    assertTrue(cut.aborts.get() >= 1);
    assertEquals(List.of(1, 0), List.of(cut.releases.get(), cut.stops.get()));
  }
}
