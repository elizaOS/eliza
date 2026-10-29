package ai.eliza.plugins.agent.connection;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The renderer-named requests a first-party transport has in flight, and its cancellation
 * contract: a cancelled request disconnects its open connection, and a browser handoff (the Cloud
 * sign-in page) settles exactly once, resolving only when the app returns to the foreground after
 * the browser was actually launched and paused it. Pure, so the state machine is tested on the
 * host JVM.
 */
public final class PendingRequests {
  /** The renderer call a browser handoff settles. */
  public interface Call {
    void resolve();

    void reject(String message);
  }

  /** One in-flight request or browser handoff. */
  public static final class Pending {
    private volatile boolean cancelled;
    private volatile Runnable disconnect;
    private volatile Call browserCall;
    private volatile boolean browserLaunched, browserPaused;

    public boolean cancelled() {
      return cancelled;
    }

    /** The open connection's disconnect, run by a later cancel. */
    public void connection(Runnable disconnect) {
      this.disconnect = disconnect;
    }

    /** Whether this entry is (or was) a browser handoff; cancelling one also forgets it. */
    public boolean browser() {
      return browserCall != null || browserLaunched;
    }

    public synchronized void cancel() {
      cancelled = true;
      Runnable current = disconnect;
      if (current != null) current.run();
      if (browserCall != null) {
        Call call = browserCall;
        browserCall = null;
        call.reject("Request cancelled");
      }
    }

    synchronized void paused() {
      if (browserCall != null && browserLaunched) browserPaused = true;
    }

    synchronized boolean returned() {
      if (browserCall == null || !browserPaused || cancelled) return false;
      Call call = browserCall;
      browserCall = null;
      call.resolve();
      return true;
    }

    /**
     * Runs the browser launch unless already cancelled or settled. A launch failure rejects the
     * call; afterwards {@link #settled()} tells the caller to forget the entry.
     */
    public synchronized void launch(Runnable action) {
      if (cancelled || browserCall == null) return;
      browserLaunched = true;
      try {
        action.run();
      } catch (RuntimeException unavailable) {
        Call call = browserCall;
        browserCall = null;
        call.reject("Authentication browser unavailable");
      }
    }

    public boolean settled() {
      return browserCall == null;
    }
  }

  private final Map<String, Pending> requests = new ConcurrentHashMap<>();

  /** A new entry for id, or null when a request with that id is already active. */
  public Pending register(String id) {
    Pending pending = new Pending();
    return requests.putIfAbsent(id, pending) == null ? pending : null;
  }

  /** A new browser handoff for id settling call, or null when that id is already active. */
  public Pending registerBrowser(String id, Call call) {
    Pending pending = new Pending();
    pending.browserCall = call;
    return requests.putIfAbsent(id, pending) == null ? pending : null;
  }

  public void remove(String id, Pending pending) {
    requests.remove(id, pending);
  }

  public int size() {
    return requests.size();
  }

  /** Cancels id when active; a cancelled browser handoff is forgotten at once. */
  public void cancel(String id) {
    Pending pending = requests.get(id);
    if (pending == null) return;
    boolean browser = pending.browser();
    pending.cancel();
    if (browser) requests.remove(id, pending);
  }

  /** The app left the foreground: launched browser handoffs may now return. */
  public void pauseAll() {
    for (Pending pending : requests.values()) pending.paused();
  }

  /** The app returned: settle every handoff whose browser paused it. */
  public void resumeAll() {
    for (Map.Entry<String, Pending> entry : requests.entrySet())
      if (entry.getValue().returned()) requests.remove(entry.getKey(), entry.getValue());
  }

  /** Teardown: cancel and forget everything. */
  public void cancelAll() {
    for (Pending pending : requests.values()) pending.cancel();
    requests.clear();
  }
}
