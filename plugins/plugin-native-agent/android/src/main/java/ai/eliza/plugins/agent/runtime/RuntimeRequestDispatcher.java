package ai.eliza.plugins.agent.runtime;

import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Bounded runtime transport work; urgent controls cannot wait behind normal IO.
 * This does not authorize routes, authenticate requests or retry rejected work. */
public final class RuntimeRequestDispatcher implements AutoCloseable {
  public enum Admission { ACCEPTED, TOO_LARGE, BUSY }
  private final ThreadPoolExecutor requests;
  private final ThreadPoolExecutor controls;
  public RuntimeRequestDispatcher() { this(4, 16, 8); }
  public RuntimeRequestDispatcher(int requestWorkers, int requestCapacity, int controlCapacity) {
    if (requestWorkers < 1 || requestCapacity < 1 || controlCapacity < 1)
      throw new IllegalArgumentException("Positive worker and queue bounds are required");
    requests = new ThreadPoolExecutor(requestWorkers, requestWorkers, 0, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(requestCapacity));
    controls = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(controlCapacity));
  }
  /** bodyTextUnits is the serialized JSON String.length(), not a byte count.
   * Request/response transport must enforce its own byte and authority limits. */
  public Admission submit(String path, int bodyTextUnits, Runnable work) {
    Objects.requireNonNull(path); Objects.requireNonNull(work);
    if (bodyTextUnits < 0) throw new IllegalArgumentException("Negative body size");
    if (bodyTextUnits > (path.equals("/voice/stt") ? 12 * 1024 * 1024 : 65536))
      return Admission.TOO_LARGE;
    boolean urgent = path.endsWith("/abort") || path.matches("/tasks/[^/]+/(pause|cancel)");
    try { (urgent ? controls : requests).execute(work); return Admission.ACCEPTED; }
    catch (RejectedExecutionException fullOrClosed) { return Admission.BUSY; }
  }
  /** Interrupt active work and discard queued work, matching host destruction. */
  @Override public void close() { requests.shutdownNow(); controls.shutdownNow(); }
}
