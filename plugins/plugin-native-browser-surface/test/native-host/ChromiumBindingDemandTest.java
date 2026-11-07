import ai.eliza.plugins.browsersurface.ChromiumBindingDemand;
import ai.eliza.plugins.browsersurface.ChromiumBindingDemand.Step;

/** Plain-JVM checks for when the owned-Chromium binding is held, released or kept warm. */
public final class ChromiumBindingDemandTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  public static void main(String[] args) {
    // The old always-on use: start() pins, nothing ever schedules a release.
    ChromiumBindingDemand pinned = new ChromiumBindingDemand(60000);
    check(!pinned.wanted(), "a new connection binds nothing");
    check(pinned.pin() == Step.BIND, "start binds");
    check(pinned.pin() == Step.BIND && pinned.wanted(), "a repeated start keeps one hold");
    check(!pinned.idleExpired(), "a pinned binding never expires");
    check(pinned.unpin() == Step.RELEASE_LATER, "stop releases after the idle delay");
    check(pinned.unpin() == Step.NONE, "a second stop changes nothing");
    check(pinned.idleExpired(), "nothing holds the binding at the deadline");

    // A page and a task overlap: the binding stays until the last one ends.
    ChromiumBindingDemand leased = new ChromiumBindingDemand(30000);
    check(leased.acquire() == Step.BIND, "the page binds");
    check(leased.acquire() == Step.BIND, "the task asks to bind too");
    check(leased.release() == Step.NONE, "the page closes while the task runs");
    check(leased.wanted(), "the task still holds the binding");
    check(leased.release() == Step.RELEASE_LATER, "the task ends");
    // A new page before the deadline takes the warm browser back.
    check(leased.acquire() == Step.BIND && !leased.idleExpired(), "a page inside the idle delay keeps it");
    check(leased.release() == Step.RELEASE_LATER && leased.idleExpired(), "released after its last holder");

    // A lease ending while start() still holds does not release.
    ChromiumBindingDemand both = new ChromiumBindingDemand(0);
    both.pin();
    both.acquire();
    check(both.release() == Step.NONE && !both.idleExpired(), "start's hold outlives a lease");
    check(both.unpin() == Step.RELEASE_LATER && both.idleMillis() == 0, "an immediate release");

    boolean threw = false;
    try { both.release(); } catch (IllegalStateException expected) { threw = true; }
    check(threw, "a release without a lease is a bug, not a silent no-op");
    threw = false;
    try { new ChromiumBindingDemand(-1); } catch (IllegalArgumentException expected) { threw = true; }
    check(threw, "a negative idle delay is refused");

    System.out.println(assertions + " assertions passed");
  }
}
