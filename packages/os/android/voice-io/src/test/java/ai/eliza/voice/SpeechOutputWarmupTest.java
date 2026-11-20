// spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public class SpeechOutputWarmupTest {
  private static final int RATE = 24_000;

  private static void await(CountDownLatch latch) throws InterruptedException {
    assertTrue("the worker did not settle", latch.await(2, TimeUnit.SECONDS));
  }

  private static class Output implements StreamingSpeechPlayback.Output {
    final AtomicInteger plays = new AtomicInteger();
    final AtomicInteger writes = new AtomicInteger();
    final AtomicInteger aborts = new AtomicInteger();
    final AtomicInteger releases = new AtomicInteger();
    final CountDownLatch entered = new CountDownLatch(1);
    final CountDownLatch released = new CountDownLatch(1);
    final CountDownLatch unblocked = new CountDownLatch(1);
    final AtomicLong clock = new AtomicLong();
    volatile boolean block;
    volatile boolean fail;
    volatile boolean empty;
    volatile boolean silenceOnly = true;

    @Override public void play() { plays.incrementAndGet(); }

    @Override
    public int write(float[] samples, int offset, int length) {
      writes.incrementAndGet();
      entered.countDown();
      if (length != RATE / SpeechOutputWarmup.CHUNKS_PER_SECOND) silenceOnly = false;
      for (float sample : samples) if (sample != 0) silenceOnly = false;
      if (fail) throw new IllegalStateException("output lost");
      if (block) {
        try {
          unblocked.await();
        } catch (InterruptedException stopped) {
          Thread.currentThread().interrupt();
        }
      }
      clock.addAndGet(20_000_000L);
      return empty ? 0 : length;
    }

    @Override public long playedFrames() { return 0; }
    @Override public long presentationNs(long frame) { return StreamingSpeechPlayback.UNSET; }
    @Override public void setVolume(float volume) {}
    @Override public void abort() { aborts.incrementAndGet(); unblocked.countDown(); }
    @Override public void stop() {}
    @Override public void release() { releases.incrementAndGet(); released.countDown(); }
  }

  private static SpeechOutputWarmup warmup(Output output) {
    return new SpeechOutputWarmup(RATE, SpeechOutputWarmup.LIMIT_NS, () -> output, output.clock::get);
  }

  @Test public void aWarmUpWritesTwentyMillisecondChunksOfSilenceUntilItsTimeLimit() throws Exception {
    Output bounded = new Output();
    warmup(bounded);
    await(bounded.released);
    assertEquals(1, bounded.plays.get());
    assertEquals(750, bounded.writes.get());
    assertTrue(bounded.silenceOnly);
    assertEquals(1, bounded.releases.get());
  }

  @Test public void theTimeLimitIsAParameter() throws Exception {
    Output shorter = new Output();
    new SpeechOutputWarmup(RATE, 100_000_000L, () -> shorter, shorter.clock::get);
    await(shorter.released);
    assertEquals(5, shorter.writes.get());
  }

  @Test public void closeAbortsABlockedWriteAndReleasesTheOutputOnce() throws Exception {
    Output blocked = new Output();
    blocked.block = true;
    SpeechOutputWarmup active = warmup(blocked);
    await(blocked.entered);
    active.close();
    active.close();
    await(blocked.released);
    assertTrue(blocked.aborts.get() >= 1);
    assertEquals(1, blocked.releases.get());
    assertEquals(1, blocked.writes.get());
    assertTrue(active.closed());
  }

  @Test public void anOutputThatOpensAfterCloseNeverPlays() throws Exception {
    Output late = new Output();
    CountDownLatch opening = new CountDownLatch(1);
    CountDownLatch continueOpen = new CountDownLatch(1);
    SpeechOutputWarmup pending = new SpeechOutputWarmup(RATE, SpeechOutputWarmup.LIMIT_NS, () -> {
      opening.countDown();
      boolean interrupted = false;
      for (;;) {
        try {
          continueOpen.await();
          break;
        } catch (InterruptedException stopped) {
          interrupted = true;
        }
      }
      if (interrupted) Thread.currentThread().interrupt();
      return late;
    }, late.clock::get);
    await(opening);
    pending.close();
    continueOpen.countDown();
    await(late.released);
    assertEquals(0, late.plays.get());
    assertEquals(0, late.writes.get());
    assertEquals(1, late.releases.get());
  }

  @Test public void playNeverRestartsAnOutputThatCloseAborted() throws Exception {
    CountDownLatch playing = new CountDownLatch(1);
    CountDownLatch continuePlay = new CountDownLatch(1);
    CountDownLatch closeDone = new CountDownLatch(1);
    boolean[] restartedAfterAbort = {false};
    Output crossing = new Output() {
      @Override public void play() {
        playing.countDown();
        try {
          continuePlay.await();
        } catch (InterruptedException stopped) {
          Thread.currentThread().interrupt();
        }
        restartedAfterAbort[0] = aborts.get() > 0;
        super.play();
      }
    };
    crossing.block = true;
    SpeechOutputWarmup crossingWarmup = warmup(crossing);
    await(playing);
    Thread closing = new Thread(() -> {
      crossingWarmup.close();
      closeDone.countDown();
    });
    closing.start();
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
    while (closing.getState() != Thread.State.BLOCKED && closeDone.getCount() != 0 && System.nanoTime() < deadline) Thread.yield();
    assertTrue(closing.getState() == Thread.State.BLOCKED || closeDone.getCount() == 0);
    continuePlay.countDown();
    await(closeDone);
    await(crossing.released);
    assertFalse(restartedAfterAbort[0]);
  }

  @Test public void aFailedWriteRetiresTheWarmUp() throws Exception {
    Output failed = new Output();
    failed.fail = true;
    warmup(failed);
    await(failed.released);
    assertEquals(1, failed.writes.get());
    assertEquals(1, failed.releases.get());
  }

  @Test public void anEmptyWriteDoesNotSpin() throws Exception {
    Output stalled = new Output();
    stalled.empty = true;
    warmup(stalled);
    await(stalled.released);
    assertEquals(1, stalled.writes.get());
  }
}
