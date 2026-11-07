package ai.eliza.plugins.securestore.nativeonly;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.Objects;
import java.util.function.LongSupplier;

/** Main-thread, replaceable expiry callback. Contains no credentials or persistent state. */
public final class NativeDeadlineTimer implements AutoCloseable {
  interface Dispatcher {
    boolean post(Runnable callback, long delay);
    void remove(Runnable callback);
  }
  private static final class AndroidDispatcher implements Dispatcher {
    private final Handler handler = new Handler(Looper.getMainLooper());
    public boolean post(Runnable callback, long delay) { return handler.postDelayed(callback, delay); }
    public void remove(Runnable callback) { handler.removeCallbacks(callback); }
  }
  private final LongSupplier clock;
  private final Dispatcher dispatcher;
  private Entry current;
  private boolean closed;
  private final class Entry implements Runnable {
    final LongSupplier remaining;
    final Runnable expired;
    Entry(LongSupplier remaining, Runnable expired) { this.remaining = remaining; this.expired = expired; }
    public void run() { check(this); }
  }
  public NativeDeadlineTimer() { this(SystemClock::elapsedRealtime, new AndroidDispatcher()); }
  NativeDeadlineTimer(LongSupplier clock, Dispatcher dispatcher) {
    this.clock = Objects.requireNonNull(clock);
    this.dispatcher = Objects.requireNonNull(dispatcher);
  }
  private static void mainThread() {
    if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Native expiry requires the main thread");
  }
  /** Replaces an earlier callback; elapsed time includes device sleep. */
  public void after(long durationMillis, Runnable expired) {
    mainThread();
    if (durationMillis <= 0) throw new IllegalArgumentException("Invalid expiry duration");
    long start = clock.getAsLong();
    watch(() -> {
      long now = clock.getAsLong(), elapsed = now - start;
      return start < 0 || now < start || elapsed < 0 || elapsed >= durationMillis ? 0 : durationMillis - elapsed;
    }, expired);
  }
  /** Remaining time must be monotonic admission state, not a fresh duration on every call.
   * May invoke expired synchronously if already expired. */
  public void watch(LongSupplier remainingMillis, Runnable expired) {
    mainThread();
    if (closed) throw new IllegalStateException("Native expiry is closed");
    Objects.requireNonNull(remainingMillis); Objects.requireNonNull(expired);
    cancel();
    current = new Entry(remainingMillis, expired);
    check(current);
  }
  private void check(Entry entry) {
    mainThread();
    if (closed || current != entry) return;
    dispatcher.remove(entry);
    long remaining;
    try { remaining = entry.remaining.getAsLong(); }
    catch (RuntimeException failure) { cancel(); throw failure; }
    if (closed || current != entry) return; // Predicate may cancel or replace the callback.
    if (remaining > 0 && dispatcher.post(entry, Math.min(remaining, Integer.MAX_VALUE))) return;
    current = null; // Clear before calling a host that may arm another deadline.
    entry.expired.run();
  }
  /** Call on resume to account for sleep or delayed Handler dispatch. */
  public void refresh() { mainThread(); if (current != null) check(current); }
  /** Cancels without calling the old destination, including already queued callbacks. */
  public void cancel() {
    mainThread();
    Entry old = current; current = null;
    if (old != null) dispatcher.remove(old);
  }
  @Override public void close() { mainThread(); cancel(); closed = true; }
}
