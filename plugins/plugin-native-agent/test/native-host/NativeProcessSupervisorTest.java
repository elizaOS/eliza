package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.NativeProcessSupervisor;
import ai.eliza.plugins.agent.runtime.NativeProcessSupervisor.State;
import java.io.*;
import java.nio.file.Path;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

public final class NativeProcessSupervisorTest {
    static int assertions;
    static void check(boolean condition) { assertions++; if (!condition) throw new AssertionError(); }
    static void until(BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(10);
        check(condition.getAsBoolean());
    }
    static ProcessBuilder child() {
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("java.class.path"), NativeProcessSupervisorTest.class.getName(), "child");
    }
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("child")) {
            if (args.length > 1) Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try { Thread.sleep(10000); } catch (InterruptedException ignored) { }
            }));
            System.out.println("ready"); System.out.flush();
            while (true) Thread.sleep(10000);
        }
        AtomicReference<Process> first = new AtomicReference<>(), second = new AtomicReference<>();
        AtomicInteger launches = new AtomicInteger(), releases = new AtomicInteger();
        try (NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            launches.incrementAndGet(); scope.onClose(releases::incrementAndGet);
            first.set(scope.start(child())); second.set(scope.start(child()));
            AtomicInteger probes = new AtomicInteger();
            scope.awaitReady(first.get(), () -> {
                if (probes.incrementAndGet() == 1) throw new IOException("Connection refused before bind");
                return true;
            }, 2000, 10);
        }, 10, 10, 1)) {
            supervisor.start();
            until(() -> supervisor.snapshot().state == State.RUNNING);
            long epoch = supervisor.snapshot().epoch;
            Process retiredFirst = first.get(), retiredSecond = second.get();
            supervisor.start(); check(launches.get() == 1);
            retiredSecond.destroyForcibly();
            until(() -> launches.get() == 2 && supervisor.snapshot().state == State.RUNNING);
            check(supervisor.snapshot().epoch > epoch);
            until(() -> !retiredFirst.isAlive() && !retiredSecond.isAlive());
            check(releases.get() == 1);
            first.get().destroyForcibly();
            until(() -> supervisor.snapshot().state == State.FAILED);
            until(() -> !second.get().isAlive()); check(launches.get() == 2); check(releases.get() == 2);
            supervisor.restart(); until(() -> supervisor.snapshot().state == State.RUNNING);
        }
        until(() -> !first.get().isAlive() && !second.get().isAlive()); check(releases.get() == 3);

        // An uncooperative probe cannot exceed the caller's startup deadline or publish late readiness.
        CountDownLatch probeEntered = new CountDownLatch(1), probeRelease = new CountDownLatch(1);
        try (NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            first.set(scope.start(child()));
            scope.awaitReady(first.get(), () -> {
                probeEntered.countDown();
                while (probeRelease.getCount() > 0) try { probeRelease.await(); } catch (InterruptedException ignored) { }
                return true;
            }, 100, 10);
        }, 10, 10, 0)) {
            supervisor.start(); check(probeEntered.await(5, TimeUnit.SECONDS));
            until(() -> supervisor.snapshot().state == State.FAILED);
            check(supervisor.snapshot().failure instanceof NativeProcessSupervisor.LifecycleException);
            probeRelease.countDown(); until(() -> !first.get().isAlive());
            check(supervisor.snapshot().state == State.FAILED);
        } finally { probeRelease.countDown(); }

        // Cancellation during startup closes resources and cannot admit a spawn after invalidation.
        CountDownLatch entered = new CountDownLatch(1), proceed = new CountDownLatch(1);
        AtomicBoolean rejected = new AtomicBoolean();
        try (NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            first.set(scope.start(child())); scope.onClose(releases::incrementAndGet); entered.countDown();
            while (proceed.getCount() > 0) try { proceed.await(); } catch (InterruptedException ignored) { }
            try { scope.start(child()); } catch (NativeProcessSupervisor.LifecycleException expected) { rejected.set(true); throw expected; }
        }, 10, 10, 0)) {
            supervisor.start(); check(entered.await(5, TimeUnit.SECONDS));
            long epoch = supervisor.snapshot().epoch;
            supervisor.invalidate(); check(supervisor.snapshot().epoch > epoch);
            proceed.countDown(); until(rejected::get); until(() -> !first.get().isAlive());
            check(supervisor.snapshot().state == State.STARTING);
        } finally { proceed.countDown(); }

        // A cleanup failure does not skip other resources or leave a successful lifecycle state.
        AtomicInteger cleaned = new AtomicInteger();
        NativeProcessSupervisor supervisor = new NativeProcessSupervisor(scope -> {
            first.set(scope.start(child())); scope.onClose(cleaned::incrementAndGet);
            scope.onClose(() -> { throw new IllegalStateException("cleanup fixture"); });
        }, 10, 10, 0);
        supervisor.start(); until(() -> supervisor.snapshot().state == State.RUNNING);
        try { supervisor.close(); throw new AssertionError(); } catch (IllegalStateException expected) { check(cleaned.get() == 1); }
        until(() -> !first.get().isAlive()); check(supervisor.snapshot().state == State.FAILED);
        try { supervisor.restart(); throw new AssertionError(); } catch (IllegalStateException expected) { check(true); }
        Process direct = child().start(); NativeProcessSupervisor.terminate(direct, 100); until(() -> !direct.isAlive());
        ProcessBuilder stubbornBuilder = child(); stubbornBuilder.command().add("stubborn");
        Process stubborn = stubbornBuilder.start();
        check("ready".equals(new BufferedReader(new InputStreamReader(stubborn.getInputStream())).readLine()));
        check(NativeProcessSupervisor.terminate(stubborn, 20)); until(() -> !stubborn.isAlive());
        Process interrupted = child().start(); Thread.currentThread().interrupt();
        NativeProcessSupervisor.terminate(interrupted, 1000); check(Thread.interrupted()); until(() -> !interrupted.isAlive());
        System.out.println("NativeProcessSupervisor: " + assertions + " assertions passed");
    }
}
