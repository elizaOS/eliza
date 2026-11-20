// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"
package ai.eliza.voice;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;

public final class StreamingSpeechPlayback {
  public interface Output {
    void play();
    int write(float[] samples, int offset, int length);
    long playedFrames();
    long presentationNs(long frame);
    default int startThresholdFrames() { return 0; }
    void setVolume(float volume);
    void abort();
    void stop();
    void release();
  }

  public interface OutputFactory { Output open() throws Exception; }

  public interface Listener {
    void firstFrame(long nanos);
    void audible(long nanos, String clock);
    void ended(boolean silent);
    void failed(String reason);
  }

  public interface Clock { long nanos(); }

  public interface Mark { void reached(long nanos, long bufferedFrames); }

  private record PendingMark(long frame, Mark mark) {}

  public static final long UNSET = Long.MIN_VALUE;
  public static final String TIMESTAMP_CLOCK = "audiotrack-timestamp";
  public static final String HEAD_CLOCK = "audiotrack-head-position";
  public static final long POLL_MS = 10;
  public static final long OFFER_TIMEOUT_MS = 30_000;
  public static final long STALL_NS = 30_000_000_000L;
  public static final long DRAIN_GRACE_NS = 2_000_000_000L;

  private final SpeechPcmQueue queue;
  private final int sampleRate;
  private final float audibleLevel;
  private final OutputFactory outputs;
  private final Listener listener;
  private final Clock clock;
  private final Object lock = new Object();
  private final ArrayDeque<PendingMark> marks = new ArrayDeque<>();
  private Output output;
  private float volume = 1f;
  private boolean outputMuted;
  private boolean started;
  private boolean terminal;
  private int open = 1;
  private int extensions;
  private boolean finished;
  private volatile boolean stopped;
  private volatile long produced;
  private volatile long audibleFrame = -1;
  private Thread writer;

  public StreamingSpeechPlayback(int capacitySamples, int sampleRate, float audibleLevel, OutputFactory outputs, Listener listener, Clock clock) {
    if (sampleRate < 8000 || sampleRate > 48000) throw new IllegalArgumentException("Unsupported sample rate");
    this.queue = new SpeechPcmQueue(capacitySamples);
    this.sampleRate = sampleRate;
    this.audibleLevel = audibleLevel;
    this.outputs = outputs;
    this.listener = listener;
    this.clock = clock;
  }

  public boolean offer(float[] samples, boolean complete) throws InterruptedException {
    if (stopped) {
      if (samples != null) Arrays.fill(samples, 0f);
      return false;
    }
    if (samples != null && samples.length > 0) {
      if (audibleFrame < 0) {
        for (int i = 0; i < samples.length; i++) {
          if (Math.abs(samples[i]) >= audibleLevel) {
            audibleFrame = produced + i;
            break;
          }
        }
      }
      produced += samples.length;
      if (!queue.offer(samples, OFFER_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return false;
    }
    if (complete) closeSegment();
    return !stopped;
  }

  public boolean extend() {
    synchronized (lock) {
      if (terminal || stopped || finished) return false;
      open++;
      extensions++;
      queue.reopen();
      return true;
    }
  }

  public void abandon() {
    closeSegment();
  }

  public void mark(Mark mark) {
    synchronized (lock) {
      marks.addLast(new PendingMark(produced, mark));
    }
  }

  public long pendingFrames() {
    synchronized (lock) {
      return Math.max(0, produced - (output == null ? 0 : output.playedFrames()));
    }
  }

  public boolean audible() {
    long frame = audibleFrame;
    if (frame < 0 || stopped) return false;
    synchronized (lock) {
      if (output == null || terminal) return false;
      long played = output.playedFrames();
      return played > frame && played < produced;
    }
  }

  public boolean finished() {
    synchronized (lock) {
      return finished;
    }
  }

  public void fail(String reason) {
    if (!settle()) return;
    stopped = true;
    queue.close();
    abortOutput();
    listener.failed(reason);
  }

  public void start() {
    synchronized (lock) {
      if (started || terminal) return;
      started = true;
      writer = new Thread(this::run, "eliza-speech-playback");
      writer.setDaemon(true);
      writer.start();
    }
  }

  public void stop() {
    synchronized (lock) {
      terminal = true;
    }
    stopped = true;
    queue.close();
    abortOutput();
  }

  public void duck(boolean ducked) {
    synchronized (lock) {
      volume = ducked ? SpeechAudioFocusPolicy.DUCK_VOLUME : 1f;
      if (output != null) output.setVolume(outputMuted ? 0f : volume);
    }
  }

  public void setOutputMuted(boolean muted) {
    synchronized (lock) {
      outputMuted = muted;
      if (output != null) output.setVolume(outputMuted ? 0f : volume);
    }
  }

  public boolean stopped() {
    return stopped;
  }

  public int queuedSamples() {
    return queue.queuedSamples();
  }

  public boolean join(long millis) throws InterruptedException {
    Thread active;
    synchronized (lock) {
      active = writer;
    }
    if (active == null) return true;
    active.join(millis);
    return !active.isAlive();
  }

  private void closeSegment() {
    synchronized (lock) {
      if (open > 0 && --open == 0) queue.complete();
    }
  }

  private void abortOutput() {
    Output active;
    synchronized (lock) {
      active = output;
    }
    if (active != null) active.abort();
  }

  private boolean settle() {
    synchronized (lock) {
      if (terminal) return false;
      terminal = true;
      return true;
    }
  }

  private void run() {
    Output out;
    try {
      out = outputs.open();
    } catch (Exception | Error unavailable) {
      if (settle()) {
        stopped = true;
        queue.close();
        listener.failed("output-unavailable");
      }
      return;
    }
    synchronized (lock) {
      if (stopped || terminal) {
        out.release();
        return;
      }
      output = out;
      out.setVolume(outputMuted ? 0f : volume);
    }
    Audible audible = new Audible();
    long written = 0;
    long lastChunkAt = clock.nanos();
    int served = 0;
    boolean first = false;
    try {
      out.play();
      for (;;) {
        for (;;) {
          int reserved = extensions();
          float[] chunk = queue.take(POLL_MS, TimeUnit.MILLISECONDS);
          audible.check(out);
          if (chunk == null) {
            if (clock.nanos() - lastChunkAt > STALL_NS) throw new IllegalStateException("synthesis-stalled");
            continue;
          }
          if (chunk == SpeechPcmQueue.END) {
            served = reserved;
            break;
          }
          reach(out, written);
          try {
            writeAll(out, chunk);
          } finally {
            Arrays.fill(chunk, 0f);
          }
          lastChunkAt = clock.nanos();
          if (!first) {
            first = true;
            listener.firstFrame(lastChunkAt);
          }
          written += chunk.length;
          audible.check(out);
        }
        long threshold = out.startThresholdFrames();
        long padded = 0;
        if (written > 0 && written < threshold && out.playedFrames() == 0) {
          float[] pad = new float[(int) (threshold - written)];
          padded = pad.length;
          writeAll(out, pad);
        }
        long drainDeadline = clock.nanos() + Math.max(0, written - out.playedFrames()) * 1_000_000_000L / sampleRate + DRAIN_GRACE_NS;
        boolean extended = false;
        while (!stopped && !(extended = extensions() != served) && out.playedFrames() < written && clock.nanos() < drainDeadline) {
          audible.check(out);
          Thread.sleep(POLL_MS);
        }
        if (stopped) return;
        if (!extended && out.playedFrames() < written) throw new IllegalStateException("playback-drain-timeout");
        if (extended || !finish(served)) {
          written += padded;
          lastChunkAt = clock.nanos();
          continue;
        }
        audible.check(out);
        audible.fallBack();
        out.stop();
        if (settle()) listener.ended(audibleFrame < 0 || !first);
        return;
      }
    } catch (CancellationException cancelled) {
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      if (settle()) {
        stopped = true;
        queue.close();
        listener.failed("playback-interrupted");
      }
    } catch (Exception | Error failure) {
      if (settle()) {
        stopped = true;
        queue.close();
        listener.failed("synthesis-stalled".equals(failure.getMessage()) ? "synthesis-stalled" : "playback-failed");
      }
    } finally {
      synchronized (lock) {
        output = null;
      }
      out.release();
    }
  }

  private void writeAll(Output out, float[] samples) throws InterruptedException {
    int offset = 0;
    while (offset < samples.length) {
      if (stopped) throw new CancellationException();
      int count = out.write(samples, offset, samples.length - offset);
      if (count < 0) throw new IllegalStateException("output-write");
      if (count == 0) Thread.sleep(POLL_MS);
      offset += count;
    }
  }

  private int extensions() {
    synchronized (lock) {
      return extensions;
    }
  }

  private boolean finish(int served) {
    synchronized (lock) {
      if (open > 0 || extensions != served) return false;
      finished = true;
      return true;
    }
  }

  private void reach(Output out, long written) {
    for (;;) {
      PendingMark next;
      synchronized (lock) {
        next = marks.peekFirst();
        if (next == null || next.frame() > written) return;
        marks.removeFirst();
      }
      next.mark().reached(clock.nanos(), Math.max(0, written - out.playedFrames()));
    }
  }

  private final class Audible {
    private boolean reported;
    private long headNs = UNSET;

    void check(Output out) {
      long frame = audibleFrame;
      if (reported || frame < 0 || stopped) return;
      long at = out.presentationNs(frame);
      if (at != UNSET) {
        reported = true;
        listener.audible(at, TIMESTAMP_CLOCK);
        return;
      }
      if (headNs == UNSET && out.playedFrames() > frame) headNs = clock.nanos();
    }

    void fallBack() {
      if (reported || headNs == UNSET) return;
      reported = true;
      listener.audible(headNs, HEAD_CLOCK);
    }
  }
}
