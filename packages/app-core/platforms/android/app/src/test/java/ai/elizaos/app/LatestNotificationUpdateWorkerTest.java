/**
 * Deterministic host-side concurrency coverage for Android notification
 * refreshes, including caller-thread isolation and latest-state replay.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;

public class LatestNotificationUpdateWorkerTest {
    private static final long AWAIT_SECONDS = 5L;

    @Test
    public void requestRunsTheUpdateAwayFromTheLifecycleCaller() throws Exception {
        Thread caller = Thread.currentThread();
        AtomicReference<Thread> updateThread = new AtomicReference<>();
        CountDownLatch updateStarted = new CountDownLatch(1);
        CountDownLatch releaseUpdate = new CountDownLatch(1);
        CountDownLatch updateFinished = new CountDownLatch(1);
        LatestNotificationUpdateWorker worker = new LatestNotificationUpdateWorker(
            "notification-test",
            () -> {
                updateThread.set(Thread.currentThread());
                updateStarted.countDown();
                await(releaseUpdate);
                updateFinished.countDown();
            }
        );

        worker.request();

        assertTrue(updateStarted.await(AWAIT_SECONDS, TimeUnit.SECONDS));
        assertNotSame(caller, updateThread.get());
        releaseUpdate.countDown();
        assertTrue(updateFinished.await(AWAIT_SECONDS, TimeUnit.SECONDS));
    }

    @Test
    public void requestsDuringAnUpdateCoalesceIntoOneLatestStateReplay() throws Exception {
        AtomicReference<String> desiredState = new AtomicReference<>("starting");
        AtomicInteger updateCount = new AtomicInteger();
        List<String> observedStates = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch firstUpdateStarted = new CountDownLatch(1);
        CountDownLatch releaseFirstUpdate = new CountDownLatch(1);
        CountDownLatch secondUpdateFinished = new CountDownLatch(1);
        LatestNotificationUpdateWorker worker = new LatestNotificationUpdateWorker(
            "notification-test",
            () -> {
                int invocation = updateCount.incrementAndGet();
                observedStates.add(desiredState.get());
                if (invocation == 1) {
                    firstUpdateStarted.countDown();
                    await(releaseFirstUpdate);
                } else if (invocation == 2) {
                    secondUpdateFinished.countDown();
                }
            }
        );

        worker.request();
        assertTrue(firstUpdateStarted.await(AWAIT_SECONDS, TimeUnit.SECONDS));

        desiredState.set("running");
        worker.request();
        worker.request();
        releaseFirstUpdate.countDown();

        assertTrue(secondUpdateFinished.await(AWAIT_SECONDS, TimeUnit.SECONDS));
        assertEquals(2, updateCount.get());
        assertEquals(Arrays.asList("starting", "running"), observedStates);
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(AWAIT_SECONDS, TimeUnit.SECONDS)) {
                throw new AssertionError("timed out waiting for deterministic test coordination");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError("test coordination interrupted", error);
        }
    }
}
