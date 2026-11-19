// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"
package ai.eliza.voice;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;

public final class SpeechPcmQueue {
  public static final int CHUNK_LIMIT = 24_000;
  public static final float[] END = new float[0];

  private final int capacity;
  private final ArrayDeque<float[]> chunks = new ArrayDeque<>();
  private int queued;
  private boolean complete;
  private boolean closed;

  public SpeechPcmQueue(int capacitySamples) {
    if (capacitySamples < CHUNK_LIMIT) throw new IllegalArgumentException("Capacity below one chunk");
    capacity = capacitySamples;
  }

  public synchronized boolean offer(float[] chunk, long timeout, TimeUnit unit) throws InterruptedException {
    if (chunk == null || chunk.length == 0 || chunk.length > CHUNK_LIMIT) throw new IllegalArgumentException("Invalid PCM chunk");
    if (complete) throw new IllegalStateException("Stream already complete");
    long deadline = System.nanoTime() + unit.toNanos(timeout);
    while (!closed && queued > 0 && queued + chunk.length > capacity) {
      long left = deadline - System.nanoTime();
      if (left <= 0) {
        Arrays.fill(chunk, 0f);
        return false;
      }
      TimeUnit.NANOSECONDS.timedWait(this, left);
    }
    if (closed) {
      Arrays.fill(chunk, 0f);
      return false;
    }
    chunks.addLast(chunk);
    queued += chunk.length;
    notifyAll();
    return true;
  }

  public synchronized void complete() {
    if (closed) return;
    complete = true;
    notifyAll();
  }

  public synchronized void reopen() {
    if (!closed) complete = false;
  }

  public synchronized float[] take(long timeout, TimeUnit unit) throws InterruptedException {
    long deadline = System.nanoTime() + unit.toNanos(timeout);
    while (!closed && chunks.isEmpty() && !complete) {
      long left = deadline - System.nanoTime();
      if (left <= 0) return null;
      TimeUnit.NANOSECONDS.timedWait(this, left);
    }
    if (closed) throw new CancellationException("Speech stream cancelled");
    if (chunks.isEmpty()) return END;
    float[] next = chunks.removeFirst();
    queued -= next.length;
    notifyAll();
    return next;
  }

  public synchronized void close() {
    closed = true;
    for (float[] chunk : chunks) Arrays.fill(chunk, 0f);
    chunks.clear();
    queued = 0;
    notifyAll();
  }

  public synchronized boolean closed() {
    return closed;
  }

  public synchronized int queuedSamples() {
    return queued;
  }

  public int capacity() {
    return capacity;
  }
}
