import ai.eliza.plugins.browsersurface.ChromiumBindingDemand;
import ai.eliza.plugins.browsersurface.ChromiumBindingDemand.BindResult;
import ai.eliza.plugins.browsersurface.ChromiumBindingDemand.Hold;
import java.util.ArrayList;
import java.util.List;

/** Plain-JVM checks for when the owned-Chromium binding binds, retries, becomes ready and is released. */
public final class ChromiumBindingDemandTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  /** A fake platform: a manual clock, and binds that answer from a script. */
  private static final class FakeHost implements ChromiumBindingDemand.Host {
    long now;
    int binds;
    int unbinds;
    BindResult answer = BindResult.ACCEPTED;
    final List<Object[]> tasks = new ArrayList<>();

    @Override public BindResult bind() { binds++; return answer; }
    @Override public void unbind() { unbinds++; }
    @Override public void schedule(Runnable task, long delayMillis) {
      tasks.add(new Object[] {task, now + delayMillis});
    }
    @Override public void cancel(Runnable task) { tasks.removeIf(entry -> entry[0] == task); }

    int pending() { return tasks.size(); }

    long nextDelay() {
      long first = Long.MAX_VALUE;
      for (Object[] entry : tasks) first = Math.min(first, (Long) entry[1]);
      return first - now;
    }

    void advance(long millis) {
      long until = now + millis;
      while (true) {
        Object[] due = null;
        for (Object[] entry : tasks)
          if ((Long) entry[1] <= until && (due == null || (Long) entry[1] < (Long) due[1])) due = entry;
        if (due == null) break;
        tasks.remove(due);
        now = (Long) due[1];
        ((Runnable) due[0]).run();
      }
      now = until;
    }
  }

  public static void main(String[] args) {
    // The old always-on use: start() pins once, nothing ever schedules a release.
    FakeHost host = new FakeHost();
    ChromiumBindingDemand pinned = new ChromiumBindingDemand(60000, host);
    check(!pinned.wanted() && host.binds == 0, "a new connection binds nothing");
    pinned.pin();
    pinned.pin();
    check(host.binds == 1 && pinned.isBound(), "a repeated start binds once");
    pinned.unpin();
    check(!pinned.wanted(), "a repeated start is one hold: one stop ends it");
    pinned.pin();
    host.advance(600000);
    check(host.unbinds == 0 && pinned.isBound(), "a pinned binding is never released");
    pinned.unpin();
    pinned.unpin();
    check(host.pending() == 1 && host.nextDelay() == 60000, "stop releases after the idle delay");
    host.advance(59999);
    check(host.unbinds == 0, "the binding stays for the whole delay");
    host.advance(1);
    check(host.unbinds == 1 && !pinned.isBound(), "the binding is released at the deadline");

    // A page and a task overlap: the binding stays until the last one ends.
    host = new FakeHost();
    ChromiumBindingDemand leased = new ChromiumBindingDemand(30000, host);
    Hold page = leased.acquire();
    Hold task = leased.acquire();
    check(host.binds == 1, "overlapping holds share one binding");
    page.close();
    check(host.pending() == 0 && leased.wanted(), "the task still holds the binding");
    task.close();
    task.close();
    check(host.pending() == 1 && !leased.wanted(), "the last holder schedules one release; a second close is a no-op");
    host.advance(10000);
    Hold next = leased.acquire();
    check(host.pending() == 0 && host.binds == 1, "a hold inside the idle delay cancels the release and keeps the warm binding");
    host.advance(600000);
    check(host.unbinds == 0, "the cancelled release never runs");
    next.close();
    host.advance(30000);
    check(host.unbinds == 1 && !leased.isBound(), "released after its last holder");
    leased.acquire();
    check(host.binds == 2 && leased.isBound(), "the next hold binds again (a cold start)");

    // start() outlives a lease.
    host = new FakeHost();
    ChromiumBindingDemand both = new ChromiumBindingDemand(0, host);
    both.pin();
    both.acquire().close();
    check(host.pending() == 0, "a lease ending while start holds schedules nothing");
    both.unpin();
    host.advance(0);
    check(host.unbinds == 1, "an immediate release");

    // Refusal retries with backoff only while wanted; the idle release stops the retries.
    host = new FakeHost();
    host.answer = BindResult.REFUSED;
    ChromiumBindingDemand refused = new ChromiumBindingDemand(5000, host);
    Hold waiter = refused.acquire();
    check(host.binds == 1 && host.nextDelay() == 1000, "a refused bind retries after one second");
    host.advance(1000);
    check(host.binds == 2 && host.nextDelay() == 2000, "the retry backs off");
    waiter.close();
    host.advance(600000);
    check(host.binds == 2 && host.pending() == 0, "no retry rebinds after the idle release");
    host.answer = BindResult.ACCEPTED;
    refused.acquire();
    check(host.binds == 3 && refused.isBound(), "a later hold binds again");

    // A lost binding retries, and the backoff restarts after an idle release.
    refused.bindingLost();
    check(!refused.isBound() && host.unbinds == 1 && host.nextDelay() == 1000, "a lost binding unbinds and retries, the backoff restarted by the idle release");
    host.advance(1000);
    check(refused.isBound() && host.binds == 4, "the retry rebinds");
    refused.close();

    // A binding lost inside the idle delay, with no holder, is not retried.
    host = new FakeHost();
    ChromiumBindingDemand idle = new ChromiumBindingDemand(5000, host);
    idle.acquire().close();
    idle.bindingLost();
    check(host.pending() == 1 && host.nextDelay() == 5000, "only the idle release is pending, no retry");
    host.advance(600000);
    check(host.binds == 1 && host.unbinds == 1, "nothing rebinds a binding nobody holds");

    // Untrusted and denied browsers are not retried.
    host = new FakeHost();
    host.answer = BindResult.UNTRUSTED;
    ChromiumBindingDemand untrusted = new ChromiumBindingDemand(5000, host);
    Hold blocked = untrusted.acquire();
    boolean[] fired = {false};
    blocked.whenReady(() -> fired[0] = true);
    check(host.pending() == 0 && !untrusted.isBound(), "an untrusted browser is not retried");
    host.answer = BindResult.DENIED;
    untrusted.pin();
    check(host.binds == 2 && host.pending() == 0, "a denied binding is not retried; a new hold asks again");
    blocked.close();
    check(!fired[0], "whenReady never fires for an untrusted or denied browser");

    // A later terminal rejection cancels a retry scheduled by an earlier refusal.
    for (BindResult rejection : new BindResult[] {BindResult.UNTRUSTED, BindResult.DENIED}) {
      host = new FakeHost();
      host.answer = BindResult.REFUSED;
      ChromiumBindingDemand rejectedRetry = new ChromiumBindingDemand(5000, host);
      rejectedRetry.acquire();
      check(host.pending() == 1, "the initial refusal queues a retry");
      host.answer = rejection;
      rejectedRetry.pin();
      check(host.pending() == 0, "a terminal rejection cancels the prior retry");
      host.advance(600000);
      check(host.binds == 2, "a cancelled retry never binds again");
      host.answer = BindResult.ACCEPTED;
      rejectedRetry.pin();
      check(rejectedRetry.isBound() && host.binds == 3, "a new explicit request can bind after rejection");
      rejectedRetry.close();
    }

    // Ready callbacks: once, on the verified connection, tied to their hold.
    host = new FakeHost();
    ChromiumBindingDemand ready = new ChromiumBindingDemand(1000, host);
    Hold dispatching = ready.acquire();
    int[] runs = {0};
    dispatching.whenReady(() -> runs[0]++);
    check(runs[0] == 0 && !ready.isReady(), "whenReady waits for the connection");
    ready.connected();
    check(runs[0] == 1 && ready.isReady(), "whenReady runs on connect");
    ready.disconnected();
    ready.connected();
    check(runs[0] == 1, "whenReady runs once only");
    dispatching.whenReady(() -> runs[0] += 10);
    check(runs[0] == 11, "whenReady runs now when already ready");
    ready.disconnected();
    check(!ready.isReady(), "a disconnect is not ready");

    // A task gives up at its deadline: its callback is dropped and never runs on a later connection.
    host = new FakeHost();
    ChromiumBindingDemand stale = new ChromiumBindingDemand(1000, host);
    Hold expired = stale.acquire();
    boolean[] staleRan = {false};
    expired.whenReady(() -> staleRan[0] = true);
    expired.close();
    check(stale.waitingCallbacks() == 0, "closing a lease frees its queued callback");
    host.advance(1000);
    check(!stale.isBound(), "the idle release unbinds");
    Hold later = stale.acquire();
    boolean[] laterRan = {false};
    later.whenReady(() -> laterRan[0] = true);
    stale.connected();
    check(!staleRan[0] && laterRan[0], "a closed lease's callback is dropped; the open one runs");

    // A callback that closes the connection stops the rest; a callback that closes another hold drops its callback.
    host = new FakeHost();
    ChromiumBindingDemand closing = new ChromiumBindingDemand(1000, host);
    Hold first = closing.acquire();
    Hold second = closing.acquire();
    Hold third = closing.acquire();
    boolean[] after = {false, false};
    first.whenReady(second::close);
    second.whenReady(() -> after[0] = true);
    third.whenReady(closing::close);
    third.whenReady(() -> after[1] = true);
    closing.connected();
    check(!after[0], "a callback dropped by its hold closing mid-drain does not run");
    check(!after[1] && closing.isClosed(), "callbacks stop once a callback closes the connection");

    // A late connection after an unbind is ignored.
    host = new FakeHost();
    ChromiumBindingDemand late = new ChromiumBindingDemand(0, host);
    Hold brief = late.acquire();
    brief.close();
    host.advance(0);
    check(!late.awaitingConnection(), "a connection after the release does not belong to any binding");
    late.connected();
    check(!late.isReady(), "a late connection is not ready");

    // Closing, including the close a failed identity check makes, never throws on the next hold.
    host = new FakeHost();
    ChromiumBindingDemand closed = new ChromiumBindingDemand(1000, host);
    Hold open = closed.acquire();
    boolean[] closedRan = {false};
    open.whenReady(() -> closedRan[0] = true);
    check(closed.awaitingConnection(), "the binding waits for its connection");
    closed.close(); // what a failed identity verification does
    check(host.unbinds == 1 && host.pending() == 0 && closed.isClosed(), "close unbinds and cancels pending work");
    closed.connected();
    check(!closedRan[0] && !closed.isReady(), "whenReady never runs after close");
    Hold inert = closed.acquire();
    check(!inert.isOpen() && host.binds == 1, "acquire after close returns a closed hold and binds nothing");
    inert.whenReady(() -> closedRan[0] = true);
    inert.close();
    open.close();
    closed.pin();
    check(!closedRan[0] && host.binds == 1 && host.pending() == 0, "nothing binds or schedules after close");

    boolean threw = false;
    try { new ChromiumBindingDemand(-1, new FakeHost()); } catch (IllegalArgumentException expected) { threw = true; }
    check(threw, "a negative idle delay is refused");

    System.out.println(assertions + " assertions passed");
  }
}
