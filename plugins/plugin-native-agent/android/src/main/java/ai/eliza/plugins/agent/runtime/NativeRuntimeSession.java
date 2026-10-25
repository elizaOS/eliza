package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;

/** Host session over the existing supervisor. No routes, credentials or product policy are selected here. */
public final class NativeRuntimeSession implements AutoCloseable {
    @FunctionalInterface public interface Launcher { void launch(Scope scope) throws Exception; }
    @FunctionalInterface public interface Request<T> { T execute() throws Exception; }
    public static final class Snapshot {
        public final NativeProcessSupervisor.Snapshot lifecycle;
        public final String instance;
        public final Map<String, Process> processes;
        private Snapshot(NativeProcessSupervisor.Snapshot lifecycle, Scope scope, String initialInstance) {
            this.lifecycle = lifecycle;
            this.instance = scope == null ? initialInstance : scope.instance;
            this.processes = scope == null ? Collections.emptyMap() : scope.processes();
        }
    }
    private final NativeProcessSupervisor supervisor;
    private volatile Scope current;
    private final String initialInstance = UUID.randomUUID().toString();

    public NativeRuntimeSession(Launcher launcher, long monitorMs, long restartDelayMs, int maxRestarts) {
        if (launcher == null) throw new IllegalArgumentException("Runtime launcher is required");
        supervisor = new NativeProcessSupervisor(scope -> {
            Scope session = new Scope(scope);
            current = session;
            launcher.launch(session);
        }, monitorMs, restartDelayMs, maxRestarts);
    }
    public Snapshot snapshot() {
        while (true) {
            NativeProcessSupervisor.Snapshot before = supervisor.snapshot();
            Snapshot result = new Snapshot(before, current, initialInstance);
            if (before == supervisor.snapshot()) return result;
        }
    }
    public void start() { supervisor.start(); }
    public void restart() { supervisor.restart(); }
    public void invalidate() { supervisor.invalidate(); }
    /** Test builds only: forcibly ends one named child of the running launch, as a crash
     * would, so the supervisor's own exit detection and bounded restart policy run. It
     * sends no request, restarts nothing itself and never touches a retired launch.
     * Returns false when the session is not running or no live child has that name. */
    public boolean injectChildExit(String name) {
        if (name == null || name.isEmpty()) return false;
        NativeProcessSupervisor.Snapshot before = supervisor.snapshot();
        Scope scope = current;
        if (before.state != NativeProcessSupervisor.State.RUNNING || scope == null) return false;
        Process process = scope.processes().get(name);
        // A lifecycle change after the lookup retires this scope; never kill a newer launch's child.
        if (process == null || !process.isAlive() || supervisor.snapshot() != before || current != scope) return false;
        process.destroyForcibly();
        return true;
    }
    @Override public void close() { supervisor.close(); }

    /** Bind resources captured by the host to their original lifecycle before dispatch.
     * A restart between endpoint selection and request admission must reject, not reuse it. */
    public <T> T request(Snapshot selected, BooleanSupplier activeHost, Request<T> request, String unavailable, String cancelled) throws Exception {
        if (selected == null) throw new IllegalArgumentException("Runtime snapshot is required");
        return request(() -> activeHost.getAsBoolean() && supervisor.snapshot() == selected.lifecycle,
                request, unavailable, cancelled);
    }

    /** Runs once, outside supervisor locks. A retired host or epoch cannot publish its response. */
    public <T> T request(BooleanSupplier activeHost, Request<T> request, String unavailable, String cancelled) throws Exception {
        NativeProcessSupervisor.Snapshot before = supervisor.snapshot();
        if (!activeHost.getAsBoolean() || before.state != NativeProcessSupervisor.State.RUNNING)
            throw new NativeProcessSupervisor.LifecycleException(unavailable);
        T response = request.execute();
        NativeProcessSupervisor.Snapshot after = supervisor.snapshot();
        if (!activeHost.getAsBoolean() || before.epoch != after.epoch || after.state != NativeProcessSupervisor.State.RUNNING)
            throw new NativeProcessSupervisor.LifecycleException(cancelled);
        return response;
    }

    /** One supervisor-owned launch; named process identities also bind health observations. */
    public static final class Scope {
        private final NativeProcessSupervisor.Scope owner;
        private final String instance = UUID.randomUUID().toString();
        private final Map<String, Process> children = new LinkedHashMap<>();
        private Scope(NativeProcessSupervisor.Scope owner) { this.owner = owner; }
        public void check() throws NativeProcessSupervisor.LifecycleException { owner.check(); }
        public void onClose(Runnable action) { owner.onClose(action); }
        private synchronized Map<String, Process> processes() {
            return Collections.unmodifiableMap(new LinkedHashMap<>(children));
        }
        /** Host configures command/env and redaction policy; the supervisor owns every spawned process. */
        public Process startReady(String name, ProcessBuilder builder, NativeProcessLog log,
                Collection<String> secrets, NativeProcessSupervisor.Probe probe, long timeoutMs, long pollMs) throws Exception {
            if (name == null || name.isEmpty() || builder == null || log == null || secrets == null || probe == null ||
                    timeoutMs <= 0 || timeoutMs > 86400000 || pollMs <= 0 || pollMs > timeoutMs)
                throw new IllegalArgumentException("Invalid runtime process configuration");
            final Collection<String> redactions = new ArrayList<>(secrets);
            for (String value : redactions) if (value != null && (value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0))
                throw new IllegalArgumentException("Log secrets must be single-line values");
            final Process process;
            synchronized (this) {
                if (children.containsKey(name)) throw new IllegalArgumentException("Duplicate runtime process name");
                builder.redirectErrorStream(true);
                process = owner.start(builder);
                children.put(name, process);
            }
            owner.check();
            Thread logger = new Thread(() -> {
                try { log.drain(process.getInputStream(), redactions); }
                catch (IOException ignored) { /* Child exit can close its private output stream. */ }
            }, "ElizaRuntimeLog");
            logger.setDaemon(true); logger.start();
            owner.awaitReady(process, probe, timeoutMs, pollMs);
            owner.check();
            return process;
        }
    }
}
