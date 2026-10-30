package ai.eliza.plugins.agent.runtime;

/** Exact service-stop ownership; acknowledgement alone does not admit another launch. */
public final class CredentialShutdownLease {
  private long sequence;
  private boolean pending, confirmed;

  /** A distinct mutation owns a distinct request, even when a prior stop is still pending. */
  public synchronized long acquire() {
    pending = true;
    confirmed = false;
    return ++sequence;
  }

  /** Retry delivery for the same owner without creating authority for an older request. */
  public synchronized long retry(long request) {
    if (!isCurrent(request)) throw new IllegalStateException("Credential shutdown owner changed");
    return request;
  }

  public synchronized boolean isCurrent(long request) { return pending && request == sequence; }

  /** Called only after the service's normal process/socket inventory has finished. */
  public synchronized void acknowledge(long request, boolean stopped) {
    if (isCurrent(request)) confirmed = stopped;
  }

  public synchronized boolean isConfirmed(long request) { return request == sequence && confirmed; }

  public synchronized boolean isReleased(long request) { return request == sequence && confirmed && !pending; }

  /** Commit or proven pre-commit cancellation releases only its own confirmed request. */
  public synchronized boolean release(long request) {
    if (request != sequence || !confirmed) return false;
    pending = false;
    return true;
  }

  public synchronized void beforeStart() {
    if (pending) throw new IllegalStateException("Credential shutdown is pending");
    ++sequence;
    confirmed = false;
  }
}
