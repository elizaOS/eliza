package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.*;
import java.io.IOException;
import java.nio.file.*;
import java.util.Arrays;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

public final class NativeRuntimeSessionTest {
    static int assertions;
    static void check(boolean value) { assertions++; if (!value) throw new AssertionError(); }
    static void until(BooleanSupplier value) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!value.getAsBoolean() && System.nanoTime() < end) Thread.sleep(10);
        check(value.getAsBoolean());
    }
    static ProcessBuilder child() {
        ProcessBuilder builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", System.getProperty("java.class.path"), NativeRuntimeSessionTest.class.getName(), "child");
        builder.environment().put("SESSION_TEST_TOKEN", "synthetic-private-token");
        return builder;
    }
    static void rejected(NativeRuntimeSession session, BooleanSupplier active, NativeRuntimeSession.Request<String> action, String expected) throws Exception {
        try { session.request(active, action, "unavailable", "cancelled"); throw new AssertionError("Accepted retired request"); }
        catch (NativeProcessSupervisor.LifecycleException failure) { check(expected.equals(failure.getMessage())); }
    }
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("child")) {
            System.out.println("ready " + System.getenv("SESSION_TEST_TOKEN")); System.out.flush();
            while (true) Thread.sleep(10000);
        }
        Path dir = Files.createTempDirectory("runtime-session-");
        NativeProcessLog log = new NativeProcessLog(dir.resolve("runtime.log"), 4096, 512);
        AtomicInteger requests = new AtomicInteger(), released = new AtomicInteger();
        AtomicBoolean active = new AtomicBoolean(true);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        try (NativeRuntimeSession session = new NativeRuntimeSession(scope -> {
            scope.onClose(released::incrementAndGet);
            scope.startReady("agent", child(), log, Arrays.asList("synthetic-private-token", null), () -> true, 2000, 10);
            scope.startReady("gateway", child(), log, Arrays.asList("synthetic-private-token"), () -> true, 2000, 10);
        }, 10, 10, 0)) {
            rejected(session, active::get, () -> { requests.incrementAndGet(); return "no"; }, "unavailable");
            check(requests.get() == 0);
            check(session.snapshot().instance != null && session.snapshot().processes.isEmpty());
            session.start(); until(() -> session.snapshot().lifecycle.state == NativeProcessSupervisor.State.RUNNING);
            NativeRuntimeSession.Snapshot first = session.snapshot();
            check(first.processes.size() == 2 && first.instance != null);
            until(() -> { try { return Files.readString(dir.resolve("runtime.log")).contains("ready"); } catch (IOException missing) { return false; } });
            check("ok".equals(session.request(first, active::get, () -> { requests.incrementAndGet(); return "ok"; }, "unavailable", "cancelled")));
            Future<String> pending = worker.submit(() -> session.request(first, active::get, () -> {
                requests.incrementAndGet(); entered.countDown(); release.await(); return "late";
            }, "unavailable", "cancelled"));
            check(entered.await(5, TimeUnit.SECONDS));
            session.restart(); until(() -> session.snapshot().lifecycle.state == NativeProcessSupervisor.State.RUNNING);
            check(!first.instance.equals(session.snapshot().instance));
            until(() -> first.processes.values().stream().noneMatch(Process::isAlive));
            release.countDown();
            try { pending.get(5, TimeUnit.SECONDS); throw new AssertionError(); }
            catch (ExecutionException failure) { check(failure.getCause() instanceof NativeProcessSupervisor.LifecycleException); }
            check(requests.get() == 2 && released.get() == 1);
            try { session.request(first, active::get, () -> { throw new AssertionError("Stale selected endpoint dispatched"); }, "unavailable", "cancelled"); throw new AssertionError("Old capture admitted after restart"); }
            catch (NativeProcessSupervisor.LifecycleException expected) { check("unavailable".equals(expected.getMessage())); }
            check("current".equals(session.request(session.snapshot(), active::get, () -> "current", "unavailable", "cancelled")));
            rejected(session, active::get, () -> { active.set(false); return "retired host"; }, "cancelled");
            rejected(session, active::get, () -> { throw new AssertionError("Inactive host called transport"); }, "unavailable");
            active.set(true);
            rejected(session, active::get, () -> { session.invalidate(); return "invalidated"; }, "cancelled");
            check(session.snapshot().lifecycle.state == NativeProcessSupervisor.State.STARTING);
            until(() -> released.get() == 2);
        } finally { release.countDown(); worker.shutdownNow(); }
        AtomicReference<Process> owned = new AtomicReference<>();
        try (NativeRuntimeSession failed = new NativeRuntimeSession(scope -> {
            owned.set(scope.startReady("agent", child(), log, Arrays.asList("synthetic-private-token"), () -> true, 2000, 10));
            scope.startReady("gateway", child(), log, Arrays.asList("synthetic-private-token"), () -> { throw new IllegalStateException("failed readiness"); }, 2000, 10);
        }, 10, 10, 0)) {
            failed.start(); until(() -> failed.snapshot().lifecycle.state == NativeProcessSupervisor.State.FAILED);
            until(() -> failed.snapshot().processes.values().stream().noneMatch(Process::isAlive));
            check(owned.get() != null && !owned.get().isAlive());
        }
        // Test-build fault injection ends one named child; the supervisor's own retry restarts it.
        AtomicInteger launches = new AtomicInteger();
        try (NativeRuntimeSession faulted = new NativeRuntimeSession(scope -> {
            launches.incrementAndGet();
            scope.startReady("agent", child(), log, Arrays.asList("synthetic-private-token"), () -> true, 2000, 10);
            scope.startReady("gateway", child(), log, Arrays.asList("synthetic-private-token"), () -> true, 2000, 10);
        }, 10, 10, 1)) {
            check(!faulted.injectChildExit("agent"));
            faulted.start(); until(() -> faulted.snapshot().lifecycle.state == NativeProcessSupervisor.State.RUNNING);
            NativeRuntimeSession.Snapshot before = faulted.snapshot();
            check(!faulted.injectChildExit("missing") && !faulted.injectChildExit("") && !faulted.injectChildExit(null));
            check(before.processes.values().stream().allMatch(Process::isAlive));
            check(faulted.injectChildExit("agent"));
            until(() -> !before.processes.get("agent").isAlive());
            until(() -> faulted.snapshot().lifecycle.state == NativeProcessSupervisor.State.RUNNING &&
                !before.instance.equals(faulted.snapshot().instance));
            NativeRuntimeSession.Snapshot after = faulted.snapshot();
            check(after.lifecycle.epoch > before.lifecycle.epoch && launches.get() == 2);
            until(() -> !before.processes.get("gateway").isAlive());
            check(after.processes.values().stream().allMatch(Process::isAlive));
            // A retired capture is never a target, and the restart budget still applies.
            check(faulted.injectChildExit("gateway"));
            until(() -> faulted.snapshot().lifecycle.state == NativeProcessSupervisor.State.FAILED);
            check(launches.get() == 2 && !faulted.injectChildExit("agent"));
            until(() -> after.processes.values().stream().noneMatch(Process::isAlive));
        }
        // The child emits the synthetic secret; both streams use the shared bounded redactor.
        check(!Files.readString(dir.resolve("runtime.log")).contains("synthetic-private-token"));
        try (var paths = Files.walk(dir)) { for (Path file : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(file); }
        System.out.println("NativeRuntimeSession: " + assertions + " assertions passed");
    }
}
