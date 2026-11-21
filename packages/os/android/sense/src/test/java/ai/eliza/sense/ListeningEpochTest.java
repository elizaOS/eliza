// spec/os/voice/listener.md, "The status chip and the host can pause or turn off listening but never start it"
package ai.eliza.sense;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class ListeningEpochTest {
  @Test public void aPauseOrStopFencesRecognitionAlreadyInFlight() throws Exception {
    ListeningEpoch epoch = new ListeningEpoch();
    assertFalse(epoch.current(epoch.ticket()));
    epoch.renew(true);
    long before = epoch.ticket();
    assertTrue(epoch.current(before));
    CountDownLatch recognizing = new CountDownLatch(1), finish = new CountDownLatch(1);
    AtomicBoolean dispatched = new AtomicBoolean();
    Thread worker = new Thread(() -> {
      recognizing.countDown();
      try {
        finish.await();
      } catch (InterruptedException interrupted) {
        throw new IllegalStateException(interrupted);
      }
      if (epoch.current(before)) dispatched.set(true);
    });
    worker.start();
    assertTrue(recognizing.await(5, TimeUnit.SECONDS));
    epoch.invalidate();
    assertFalse(epoch.current(before));
    epoch.renew(true);
    long after = epoch.ticket();
    finish.countDown();
    worker.join(5000);
    assertTrue(!worker.isAlive() && !dispatched.get());
    assertTrue(epoch.current(after));
    epoch.invalidate();
    epoch.renew(true);
    assertFalse(epoch.current(after));
    epoch.renew(false);
    assertFalse(epoch.current(epoch.ticket()));
  }
}
