package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

/** Owns direct child processes; Android service identity, commands and policy belong to the host. */
public final class NativeProcessSupervisor implements AutoCloseable {
    public enum State { STOPPED, STARTING, RUNNING, FAILED }
    @FunctionalInterface public interface Launcher { void launch(Scope scope) throws Exception; }
    @FunctionalInterface public interface Probe { boolean ready() throws Exception; }
    public static final class LifecycleException extends IOException {
        public LifecycleException(String message) { super(message); }
    }
    public static final class Snapshot {
        public final long epoch;
        public final State state;
        public final Exception failure;
        private Snapshot(long epoch, State state, Exception failure) {
            this.epoch = epoch; this.state = state; this.failure = failure;
        }
    }
    private volatile Thread runner;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "ElizaNativeProcesses"); thread.setDaemon(true); runner = thread; return thread;
    });
    private final Launcher launcher;
    private final long monitorMs, restartDelayMs;
    private final int maxRestarts;
    private volatile Snapshot snapshot = new Snapshot(0, State.STOPPED, null);
    private Scope current;
    private Future<?> pending;
    private boolean closed;

    public NativeProcessSupervisor(Launcher launcher, long monitorMs, long restartDelayMs, int maxRestarts) {
        if (launcher == null || monitorMs <= 0 || restartDelayMs <= 0 || maxRestarts < 0 ||
                maxRestarts > 100 || monitorMs > 86400000 || restartDelayMs > 86400000)
            throw new IllegalArgumentException("Invalid native process supervision policy");
        this.launcher = launcher; this.monitorMs = monitorMs;
        this.restartDelayMs = restartDelayMs; this.maxRestarts = maxRestarts;
    }
    public Snapshot snapshot() { return snapshot; }
    public synchronized void start() {
        if (closed) throw new IllegalStateException("Native process supervisor is closed");
        if (snapshot.state != State.STARTING && snapshot.state != State.RUNNING) begin(0, 0);
    }
    public synchronized void restart() {
        if (closed) throw new IllegalStateException("Native process supervisor is closed");
        begin(0, 0);
    }
    /** Immediately fence replies before the host delivers its restart command. */
    public synchronized void invalidate() {
        if (closed) throw new IllegalStateException("Native process supervisor is closed");
        snapshot = new Snapshot(snapshot.epoch + 1, State.STARTING, null);
        retire();
    }
    private void retire() {
        if (pending != null) pending.cancel(Thread.currentThread() != runner);
        Scope retired = current; current = null;
        if (retired != null) {
            try { retired.close(); }
            catch (RuntimeException failure) {
                snapshot = new Snapshot(snapshot.epoch, State.FAILED, failure); throw failure;
            }
        }
    }
    private void begin(int attempt, long delayMs) {
        snapshot = new Snapshot(snapshot.epoch + 1, State.STARTING, null);
        retire();
        Scope scope = new Scope(); current = scope;
        pending = worker.schedule(() -> launch(scope, attempt), delayMs, TimeUnit.MILLISECONDS);
    }
    private void launch(Scope scope, int attempt) {
        try {
            scope.check(); launcher.launch(scope); scope.check();
            synchronized (this) {
                if (closed || current != scope) return;
                if (!scope.alive()) throw new LifecycleException("Native child exited during startup");
                snapshot = new Snapshot(snapshot.epoch, State.RUNNING, null);
                pending = worker.schedule(() -> monitor(scope, attempt), monitorMs, TimeUnit.MILLISECONDS);
            }
        } catch (Exception failure) {
            synchronized (this) {
                if (current != scope || closed) return;
                try { scope.close(); } catch (RuntimeException cleanup) { failure.addSuppressed(cleanup); }
                snapshot = new Snapshot(snapshot.epoch, State.FAILED, failure);
            }
        }
    }
    private synchronized void monitor(Scope scope, int attempt) {
        if (closed || current != scope) return;
        if (scope.alive()) {
            pending = worker.schedule(() -> monitor(scope, attempt), monitorMs, TimeUnit.MILLISECONDS);
        } else if (attempt < maxRestarts) {
            begin(attempt + 1, restartDelayMs * (attempt + 1));
        } else {
            Exception failure = new LifecycleException("Native child stopped unexpectedly");
            try { scope.close(); } catch (RuntimeException cleanup) { failure.addSuppressed(cleanup); }
            snapshot = new Snapshot(snapshot.epoch, State.FAILED, failure);
        }
    }
    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        snapshot = new Snapshot(snapshot.epoch + 1, State.STOPPED, null);
        try { retire(); } finally { worker.shutdownNow(); }
    }

    /** One launch's resources; a late spawn is killed before it can be admitted. */
    public static final class Scope implements AutoCloseable {
        private final List<Process> processes = new ArrayList<>();
        private final List<Runnable> cleanup = new ArrayList<>();
        private final ExecutorService probes = Executors.newSingleThreadExecutor(r -> {
            Thread thread = new Thread(r, "ElizaNativeReadiness"); thread.setDaemon(true); return thread;
        });
        private volatile boolean closed;
        private Scope() {}
        public void check() throws LifecycleException {
            if (closed || Thread.currentThread().isInterrupted()) throw new LifecycleException("Native launch cancelled");
        }
        public Process start(ProcessBuilder builder) throws IOException {
            check(); Process process = builder.start();
            synchronized (this) {
                if (closed) { process.destroyForcibly(); throw new LifecycleException("Native launch cancelled"); }
                processes.add(process); return process;
            }
        }
        public synchronized void onClose(Runnable action) {
            if (action == null) throw new IllegalArgumentException("Cleanup action is required");
            if (closed) action.run(); else cleanup.add(action);
        }
        private synchronized boolean alive() {
            if (closed || processes.isEmpty()) return false;
            for (Process process : processes) if (!process.isAlive()) return false;
            return true;
        }
        public void awaitReady(Process process, Probe probe, long timeoutMs, long pollMs) throws Exception {
            if (timeoutMs <= 0 || timeoutMs > 86400000 || pollMs <= 0 || pollMs > timeoutMs)
                throw new IllegalArgumentException("Invalid native readiness budget");
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
            while (true) {
                check();
                if (!process.isAlive()) throw new LifecycleException("Native child exited before readiness");
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new LifecycleException("Native child readiness timed out");
                Future<Boolean> request = probes.submit(probe::ready);
                boolean ready = false;
                try { ready = request.get(remaining, TimeUnit.NANOSECONDS); }
                catch (TimeoutException timeout) { throw new LifecycleException("Native child readiness timed out"); }
                catch (ExecutionException failure) {
                    if (!(failure.getCause() instanceof IOException)) {
                        if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause();
                        throw failure;
                    }
                    // Connection refusal and socket timeouts are expected until the child binds.
                } finally { request.cancel(true); }
                check();
                if (!process.isAlive()) throw new LifecycleException("Native child exited before readiness");
                remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new LifecycleException("Native child readiness timed out");
                if (ready) return;
                TimeUnit.NANOSECONDS.sleep(Math.min(remaining, TimeUnit.MILLISECONDS.toNanos(pollMs)));
            }
        }
        @Override public synchronized void close() {
            if (closed) return; closed = true; probes.shutdownNow();
            RuntimeException failure = null;
            for (Process process : processes) {
                try { process.destroyForcibly(); }
                catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
            }
            for (int i = cleanup.size() - 1; i >= 0; i--) {
                try { cleanup.get(i).run(); }
                catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
            }
            if (failure != null) throw failure;
        }
    }

    /** Graceful direct-child stop shared with the canonical Android service. */
    public static boolean terminate(Process process, long graceMs) {
        if (graceMs < 0 || graceMs > 86400000) throw new IllegalArgumentException("Invalid shutdown grace");
        process.destroy();
        try { if (process.waitFor(graceMs, TimeUnit.MILLISECONDS)) return false; }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        if (process.isAlive()) { process.destroyForcibly(); return true; }
        return false;
    }
}
