package ai.eliza.plugins.agent.runtime;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** App-domain direct-child ownership, separate from Bun/agent or foreground-service qualification. */
@RunWith(AndroidJUnit4.class)
public final class NativeProcessSupervisorInstrumentedTest {
    private static void until(BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(20);
        assertTrue(condition.getAsBoolean());
    }
    private static ProcessBuilder child() { return new ProcessBuilder("/system/bin/sleep", "30"); }
    @Test public void groupDeathRetriesWithinHostBudgetAndCleansEveryChild() throws Exception {
        AtomicReference<Process> agent = new AtomicReference<>(), gateway = new AtomicReference<>();
        AtomicInteger launches = new AtomicInteger(), cleanups = new AtomicInteger();
        try (NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            launches.incrementAndGet(); agent.set(scope.start(child())); gateway.set(scope.start(child()));
            scope.onClose(cleanups::incrementAndGet);
            scope.awaitReady(agent.get(), () -> true, 5000, 20);
        }, 20, 20, 1)) {
            supervisor.start(); until(() -> supervisor.snapshot().state == NativeProcessSupervisor.State.RUNNING);
            Process oldAgent = agent.get(), oldGateway = gateway.get(); long epoch = supervisor.snapshot().epoch;
            oldGateway.destroyForcibly();
            until(() -> launches.get() == 2 && supervisor.snapshot().state == NativeProcessSupervisor.State.RUNNING);
            assertTrue(supervisor.snapshot().epoch > epoch); until(() -> !oldAgent.isAlive() && !oldGateway.isAlive());
            agent.get().destroyForcibly(); until(() -> supervisor.snapshot().state == NativeProcessSupervisor.State.FAILED);
            until(() -> !gateway.get().isAlive()); assertEquals(2, launches.get()); assertEquals(2, cleanups.get());
        }
    }
    @Test public void cancellationFencesLateReadinessAndReleasesProcess() throws Exception {
        AtomicReference<Process> process = new AtomicReference<>();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            process.set(scope.start(child()));
            scope.awaitReady(process.get(), () -> { entered.countDown(); release.await(); return true; }, 5000, 20);
        }, 20, 20, 0);
        try {
            supervisor.start(); assertTrue(entered.await(10, TimeUnit.SECONDS)); long epoch = supervisor.snapshot().epoch;
            supervisor.close(); release.countDown(); until(() -> !process.get().isAlive());
            assertTrue(supervisor.snapshot().epoch > epoch); assertEquals(NativeProcessSupervisor.State.STOPPED, supervisor.snapshot().state);
        } finally { release.countDown(); supervisor.close(); }
    }
    @Test public void stalledProbeCannotPublishReadinessAfterItsDeadline() throws Exception {
        AtomicReference<Process> process = new AtomicReference<>();
        CountDownLatch release = new CountDownLatch(1);
        try (NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            process.set(scope.start(child()));
            scope.awaitReady(process.get(), () -> {
                while (release.getCount() > 0) try { release.await(); } catch (InterruptedException ignored) { }
                return true;
            }, 100, 20);
        }, 20, 20, 0)) {
            supervisor.start(); until(() -> supervisor.snapshot().state == NativeProcessSupervisor.State.FAILED);
            release.countDown(); until(() -> !process.get().isAlive());
            assertTrue(supervisor.snapshot().failure instanceof NativeProcessSupervisor.LifecycleException);
        } finally { release.countDown(); }
    }
}
