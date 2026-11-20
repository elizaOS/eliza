// spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"
package ai.eliza.voice;

import java.util.function.LongSupplier;

public final class SpeechOutputWarmup implements AutoCloseable {
  public static final long LIMIT_NS = 15_000_000_000L;
  public static final int CHUNKS_PER_SECOND = 50;

  private final Object lifecycle = new Object();
  private final Thread writer;
  private volatile boolean closed;
  private StreamingSpeechPlayback.Output output;

  public SpeechOutputWarmup(int rate, long limitNs, StreamingSpeechPlayback.OutputFactory factory, LongSupplier now) {
    if (rate < CHUNKS_PER_SECOND || limitNs <= 0) throw new IllegalArgumentException("Invalid warm-up");
    long started = now.getAsLong();
    writer = new Thread(() -> run(rate, limitNs, started, factory, now), "eliza-speech-warmup");
    writer.setDaemon(true);
    writer.start();
  }

  private void run(int rate, long limitNs, long started, StreamingSpeechPlayback.OutputFactory factory, LongSupplier now) {
    StreamingSpeechPlayback.Output opened = null;
    try {
      opened = factory.open();
      synchronized (lifecycle) {
        if (closed) return;
        output = opened;
        opened.play();
      }
      float[] silence = new float[rate / CHUNKS_PER_SECOND];
      while (now.getAsLong() - started < limitNs && !closed) {
        if (opened.write(silence, 0, silence.length) <= 0) break;
      }
    } catch (Exception unavailable) {
    } finally {
      synchronized (lifecycle) {
        if (output == opened) output = null;
      }
      if (opened != null) {
        try {
          opened.abort();
        } finally {
          opened.release();
        }
      }
    }
  }

  public boolean closed() {
    return closed;
  }

  @Override
  public void close() {
    StreamingSpeechPlayback.Output active;
    synchronized (lifecycle) {
      closed = true;
      active = output;
    }
    if (active != null) active.abort();
    writer.interrupt();
  }
}
