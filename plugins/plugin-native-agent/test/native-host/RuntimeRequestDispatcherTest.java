package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.RuntimeRequestDispatcher;
import static ai.eliza.plugins.agent.runtime.RuntimeRequestDispatcher.Admission.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class RuntimeRequestDispatcherTest {
  private static int assertions;
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("assertion " + assertions); }
  private static void await(CountDownLatch latch) throws Exception { check(latch.await(15, TimeUnit.SECONDS)); }
  public static void main(String[] args) throws Exception {
    for (String urgent : new String[]{"/conversations/one/abort", "/tasks/one/pause", "/tasks/one/cancel"}) {
      RuntimeRequestDispatcher dispatcher = new RuntimeRequestDispatcher(1, 1, 1);
      CountDownLatch normalStarted = new CountDownLatch(1), controlStarted = new CountDownLatch(1);
      CountDownLatch interrupted = new CountDownLatch(2), hold = new CountDownLatch(1);
      AtomicInteger queuedRuns = new AtomicInteger();
      try {
        check(dispatcher.submit("/messages", 0, () -> {
          normalStarted.countDown(); try { hold.await(); } catch (InterruptedException expected) { interrupted.countDown(); }
        }) == ACCEPTED); await(normalStarted);
        check(dispatcher.submit("/messages", 0, queuedRuns::incrementAndGet) == ACCEPTED);
        check(dispatcher.submit("/messages", 0, queuedRuns::incrementAndGet) == BUSY);
        check(dispatcher.submit(urgent, 0, () -> {
          controlStarted.countDown(); try { hold.await(); } catch (InterruptedException expected) { interrupted.countDown(); }
        }) == ACCEPTED); await(controlStarted);
        check(dispatcher.submit(urgent, 0, queuedRuns::incrementAndGet) == ACCEPTED);
        check(dispatcher.submit(urgent, 0, queuedRuns::incrementAndGet) == BUSY);
        dispatcher.close(); await(interrupted);
        check(dispatcher.submit("/messages", 0, queuedRuns::incrementAndGet) == BUSY);
        check(dispatcher.submit(urgent, 0, queuedRuns::incrementAndGet) == BUSY);
        check(queuedRuns.get() == 0);
      } finally { dispatcher.close(); hold.countDown(); }
    }
    try (RuntimeRequestDispatcher dispatcher = new RuntimeRequestDispatcher()) {
      AtomicInteger rejectedRuns = new AtomicInteger();
      check(dispatcher.submit("/messages", 65537, rejectedRuns::incrementAndGet) == TOO_LARGE);
      check(dispatcher.submit("/voice/stt", 12 * 1024 * 1024 + 1, rejectedRuns::incrementAndGet) == TOO_LARGE);
      CountDownLatch completed = new CountDownLatch(2);
      check(dispatcher.submit("/messages", 65536, completed::countDown) == ACCEPTED);
      check(dispatcher.submit("/voice/stt", 12 * 1024 * 1024, completed::countDown) == ACCEPTED);
      await(completed); check(rejectedRuns.get() == 0);
      try { dispatcher.submit("/messages", -1, () -> {}); throw new AssertionError("negative size accepted"); }
      catch (IllegalArgumentException expected) { assertions++; }
    }
    System.out.println("RuntimeRequestDispatcher: " + assertions + " assertions passed");
  }
}
