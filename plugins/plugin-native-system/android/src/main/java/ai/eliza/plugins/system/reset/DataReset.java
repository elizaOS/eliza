package ai.eliza.plugins.system.reset;

import ai.eliza.plugins.system.SenseListenerClient;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Package-scoped reset of a host app's own data.
 *
 * <p>Android owns the deletion: {@link ActivityManager#clearApplicationUserData()} scopes it to
 * this package and Android user, stops every process of the package, cancels its jobs, alarms and
 * notifications, clears its private data and its UID Keystore namespace. Nothing here enumerates
 * or deletes files, shared media, another app's storage or remote account data.
 *
 * <p>A confirmed request is persisted as a marker in device-protected no-backup storage before
 * dispatch, and {@link #admitBeforeStartup} retries it before content providers, initializers or
 * runtime callbacks run on a later launch. The marker covers interruption before Android accepts
 * the request; it is itself app data, so it is not a guarantee of atomic filesystem deletion or of
 * recovery from power loss midway through Android's clear.
 *
 * <p>Fail closed: a same-signer companion listener (see {@link SenseListenerClient#resetForData})
 * must durably acknowledge consent revocation before the clear is requested; an installed listener
 * that cannot acknowledge keeps the marker and every byte of app data. The old runtime never
 * resumes while the marker exists. A start the user is looking at opens the host's recovery
 * activity in its own provider-free process; background starts (jobs, alarms, broadcasts, pushes,
 * providers, bound services) stop silently. Automatic attempts are bounded; the recovery surface's
 * retry is always a fresh attempt.
 *
 * <p>Each attempt is counted before it starts: the failure record is written as {@code OPEN} before
 * the listener call and Android's clear, then rewritten with the outcome. Android's clear deletes
 * the record, so an {@code OPEN} record a later start finds proves the attempt died or the clear did
 * not finish; that start defers to recovery instead of looping. Every read-modify-write of the
 * record holds a file lock shared by all processes of the package.
 *
 * <p>Hosts supply installed identities (marker name, recovery activity and its process) and
 * optional bounded work before dispatch, such as revoking a remote sign-in. Build one instance per
 * product and share it between the Application, the plugin and the recovery activity.
 */
public final class DataReset {
    /** Automatic (unprompted) attempts allowed within {@link #AUTOMATIC_WINDOW_MS}. */
    public static final int AUTOMATIC_ATTEMPTS = 3;
    public static final long AUTOMATIC_WINDOW_MS = 60_000;
    /** Budget for {@link BeforeDispatch} when an interrupted reset resumes at startup. */
    public static final long STARTUP_BEFORE_DISPATCH_MS = 4_000;
    /** Budget for {@link BeforeDispatch} after a fresh confirmation; the clear follows regardless. */
    public static final long INTERACTIVE_DEADLINE_MS = 8_000;

    public enum Outcome { DISPATCHED, LISTENER_UNACKNOWLEDGED, ANDROID_REFUSED, DEFERRED }

    /**
     * Bounded, best-effort host work before Android's clear, for example revoking this device's
     * remote sign-in while the credential still exists. It runs only while a confirmed reset is
     * pending, must return within {@code timeoutMs}, and can never cancel or delay the local reset
     * beyond that budget.
     */
    public interface BeforeDispatch {
        void run(Context context, long timeoutMs);
    }

    /**
     * A {@link BeforeDispatch} that returns true when the remote side answered (for example revoked
     * the sign-in, or said it was already invalid). The answer is remembered inside app data, so the
     * step is not repeated for this reset; Android's clear removes the record with everything else.
     */
    public interface AnsweredBeforeDispatch {
        boolean run(Context context, long timeoutMs);
    }

    /** Main-thread scheduling, injectable so dispatch ordering is testable without a Looper. */
    public interface Scheduler {
        void post(Runnable task);
        void postDelayed(Runnable task, long delayMs);
    }

    private final String markerName;
    private final Class<? extends Activity> recoveryActivity;
    private final String recoveryProcessSuffix;
    private final String logTag;
    private final AnsweredBeforeDispatch beforeDispatch;

    private DataReset(Builder builder) {
        markerName = builder.markerName;
        recoveryActivity = builder.recoveryActivity;
        recoveryProcessSuffix = builder.recoveryProcessSuffix;
        logTag = builder.logTag;
        beforeDispatch = builder.beforeDispatch;
    }

    /**
     * @param markerName installed base name of the pending marker and attempt counter, for example
     *     {@code "reset-example"}; keep it stable across releases so an interrupted reset resumes
     * @param recoveryActivity the host's {@link DataResetRecoveryActivity}, declared unexported in
     *     its own process (see {@link Builder#recoveryProcessSuffix})
     */
    public static Builder builder(String markerName, Class<? extends Activity> recoveryActivity) {
        return new Builder(markerName, recoveryActivity);
    }

    public static final class Builder {
        private final String markerName;
        private final Class<? extends Activity> recoveryActivity;
        private String recoveryProcessSuffix = ":reset_recovery";
        private String logTag = "ElizaDataReset";
        private AnsweredBeforeDispatch beforeDispatch;

        private Builder(String markerName, Class<? extends Activity> recoveryActivity) {
            if (markerName == null || !markerName.matches("[a-z0-9][a-z0-9._-]{0,63}")) throw new IllegalArgumentException("Invalid reset marker name");
            if (recoveryActivity == null) throw new IllegalArgumentException("A recovery activity is required");
            this.markerName = markerName;
            this.recoveryActivity = recoveryActivity;
        }

        /** The {@code android:process} of the recovery activity, which must install no providers. */
        public Builder recoveryProcessSuffix(String suffix) {
            if (suffix == null || !suffix.matches(":[a-z][a-z0-9_]{0,63}")) throw new IllegalArgumentException("Invalid recovery process suffix");
            recoveryProcessSuffix = suffix;
            return this;
        }

        public Builder logTag(String tag) {
            if (tag == null || tag.isEmpty() || tag.length() > 23) throw new IllegalArgumentException("Invalid log tag");
            logTag = tag;
            return this;
        }

        /** Work that runs again on every attempt until the reset finishes. */
        public Builder beforeDispatch(BeforeDispatch work) {
            beforeDispatch = work == null ? null : (context, timeoutMs) -> {
                work.run(context, timeoutMs);
                return false;
            };
            return this;
        }

        /** Work that stops running once it reports that the remote side answered. */
        public Builder beforeDispatchAnswered(AnsweredBeforeDispatch work) {
            beforeDispatch = work;
            return this;
        }

        public DataReset build() {
            return new DataReset(this);
        }
    }

    public String recoveryProcessSuffix() {
        return recoveryProcessSuffix;
    }

    private static final java.util.concurrent.locks.ReentrantLock ATTEMPT_LOCK = new java.util.concurrent.locks.ReentrantLock();
    private interface Locked<T> { T run() throws Exception; }

    /** Main and recovery processes reserve the same durable budget before any reset attempt. */
    private <T> T locked(Context context, Locked<T> operation) throws Exception {
        if (!ATTEMPT_LOCK.tryLock()) throw new java.io.IOException("Reset attempt already active");
        try (RandomAccessFile file = new RandomAccessFile(new File(directory(context), markerName + ".lock"), "rw")) {
            FileLock lease = file.getChannel().tryLock();
            if (lease == null) throw new java.io.IOException("Reset attempt already active");
            try (FileLock ignored = lease) { return operation.run(); }
        } finally {
            ATTEMPT_LOCK.unlock();
        }
    }

    private static File directory(Context context) {
        return context.createDeviceProtectedStorageContext().getNoBackupFilesDir();
    }

    private AtomicFile marker(Context context) {
        return new AtomicFile(new File(directory(context), markerName + ".pending"));
    }

    private AtomicFile failures(Context context) {
        return new AtomicFile(new File(directory(context), markerName + ".failures"));
    }

    private AtomicFile answered(Context context) {
        return new AtomicFile(new File(directory(context), markerName + ".answered"));
    }

    private static boolean exists(AtomicFile file) {
        return file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists();
    }

    public boolean pending(Context context) {
        return exists(marker(context));
    }

    /** The fresh budget is durable before its marker can authorize automatic attempts. */
    public void record(Context context) throws Exception {
        locked(context, () -> {
            if (pending(context)) return null;
            answered(context).delete();
            write(failures(context), "0:0".getBytes(StandardCharsets.US_ASCII));
            write(marker(context), new byte[] {1});
            return null;
        });
    }

    /**
     * Records the confirmed request unless a same-signer listener is installed but cannot answer
     * ({@link SenseListenerClient#blocksReset}). Then it writes nothing and returns false: the reset
     * would only stop at the listener, and the app would stay closed in recovery.
     */
    public boolean recordIfListenerReachable(Context context) throws Exception {
        if (new SenseListenerClient(context).blocksReset()) return false;
        record(context);
        return true;
    }

    /**
     * Which ACTION_DIAL handler recovery opens: the system dialer when it is another package, else
     * the first other handler, else -1. Never this package: its dial pad starts the main process,
     * which admission turns back into recovery or an unrequested attempt.
     */
    public static int recoveryDialer(String self, String systemDialer, java.util.List<String> handlers) {
        int other = -1;
        for (int i = 0; i < handlers.size(); i++) {
            String handler = handlers.get(i);
            if (handler == null || handler.equals(self)) continue;
            if (handler.equals(systemDialer)) return i;
            if (other < 0) other = i;
        }
        return other;
    }

    /** True once {@link AnsweredBeforeDispatch} reported an answer for the pending reset. */
    public boolean revocationAnswered(Context context) {
        return exists(answered(context));
    }

    private static void write(AtomicFile file, byte[] value) throws Exception {
        FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(value);
            out.getFD().sync();
            file.finishWrite(out);
            out = null;
            java.io.FileDescriptor parent = android.system.Os.open(file.getBaseFile().getParent(), android.system.OsConstants.O_RDONLY, 0);
            try {
                android.system.Os.fsync(parent);
            } finally {
                android.system.Os.close(parent);
            }
            if (!java.util.Arrays.equals(file.readFully(), value)) throw new java.io.IOException("Reset write was not committed");
        } finally {
            if (out != null) file.failWrite(out);
        }
    }

    /** Third field of an attempt that started and has not recorded its outcome. */
    private static final String OPEN = "OPEN";

    /**
     * The failure record: {@code count:first[:outcome]}, where the outcome is a failed
     * {@link Outcome} or {@link #OPEN}. Builds before the outcome field wrote two parts; an
     * interrupted reset from such a build still resumes with its budget.
     */
    private String[] failureRecord(Context context) {
        AtomicFile file = failures(context);
        if (!exists(file)) return null;
        try {
            return new String(file.readFully(), StandardCharsets.US_ASCII).trim().split(":", -1);
        } catch (Exception unreadable) {
            return new String[0];
        }
    }

    private static Outcome outcomeNamed(String name) {
        for (Outcome outcome : Outcome.values()) {
            if (outcome != Outcome.DISPATCHED && outcome != Outcome.DEFERRED && outcome.name().equals(name)) return outcome;
        }
        return null;
    }

    /**
     * {count, first failure time in the current window}. Unreadable or corrupt state counts as an
     * exhausted budget until a user-initiated attempt starts a new window.
     */
    public long[] failureState(Context context) {
        String[] parts = failureRecord(context);
        if (parts == null) return pending(context) ? new long[] {AUTOMATIC_ATTEMPTS, -1} : new long[] {0, 0};
        try {
            long count = Long.parseLong(parts[0]), first = Long.parseLong(parts[1]);
            boolean shape = parts.length == 2 || (parts.length == 3 && (OPEN.equals(parts[2]) || outcomeNamed(parts[2]) != null));
            // A negative or overflowing count would otherwise grant unbounded automatic attempts.
            if (shape && count >= 0 && count <= Integer.MAX_VALUE && first >= 0) return new long[] {count, first};
        } catch (Exception unreadable) {
            // Treated as exhausted below.
        }
        return new long[] {AUTOMATIC_ATTEMPTS, -1};
    }

    /**
     * Why the most recent attempt did not dispatch ({@link Outcome#LISTENER_UNACKNOWLEDGED} or
     * {@link Outcome#ANDROID_REFUSED}), or null when no attempt has failed since the confirmation
     * or the record does not say. Recovery explains this rather than guessing from listener state.
     */
    public Outcome lastFailure(Context context) {
        String[] parts = failureRecord(context);
        return parts != null && parts.length == 3 ? outcomeNamed(parts[2]) : null;
    }

    public static boolean automaticAttemptAllowed(long[] state, long now) {
        if (state[0] < AUTOMATIC_ATTEMPTS) return true;
        if (state[1] < 0) return false;
        // A wall-clock step backwards also starts a new window rather than deferring forever.
        return now < state[1] || now - state[1] >= AUTOMATIC_WINDOW_MS;
    }

    private void recordFailure(Context context, long count, long first, Outcome outcome) {
        if (!pending(context)) return;
        try {
            write(failures(context), (count + ":" + first + ":" + outcome.name()).getBytes(StandardCharsets.US_ASCII));
        } catch (Exception unavailable) {
            // The reservation remains durable even if the more specific result cannot be recorded.
        }
    }

    /** Explicit recovery can repair legacy budgets or exceed the automatic limit. */
    public Outcome retry(Context context, long now) { return admittedAttempt(context, now, true); }

    /** Compatibility entry point for callers explicitly retrying a confirmed reset. */
    public Outcome attempt(Context context, long now) { return retry(context, now); }

    public Outcome automaticAttempt(Context context, long now) { return admittedAttempt(context, now, false); }

    private Outcome admittedAttempt(Context context, long now, boolean explicit) {
        return admittedAttempt(context, now, explicit, 0);
    }

    private Outcome admittedAttempt(Context context, long now, boolean explicit, long beforeDispatchMs) {
        if (now < 0 || !pending(context)) return Outcome.DEFERRED;
        try {
            return locked(context, () -> {
                if (!pending(context)) return Outcome.DEFERRED;
                long[] state = failureState(context);
                String[] record = failureRecord(context);
                if (!explicit && record != null && record.length == 3 && OPEN.equals(record[2])) {
                    write(failures(context), (state[0] + ":" + state[1]).getBytes(StandardCharsets.US_ASCII));
                    return Outcome.DEFERRED;
                }
                if (!explicit && !automaticAttemptAllowed(state, now)) return Outcome.DEFERRED;
                boolean newWindow = state[1] < 0 || state[0] == 0 || now < state[1] || now - state[1] >= AUTOMATIC_WINDOW_MS;
                long count = newWindow ? 1 : Math.min(state[0] + 1, Integer.MAX_VALUE);
                long first = newWindow ? now : state[1];
                // A crash or failed write cannot grant the next process this reservation again.
                write(failures(context), (count + ":" + first + ":" + OPEN).getBytes(StandardCharsets.US_ASCII));
                runBoundedBeforeDispatch(context, beforeDispatchMs);
                if (!pending(context)) return Outcome.DEFERRED;
                Outcome outcome;
                try {
                    boolean acknowledged;
                    try { acknowledged = new SenseListenerClient(context).resetForData(); }
                    catch (RuntimeException listenerFailure) { acknowledged = false; }
                    if (!acknowledged) {
                        outcome = Outcome.LISTENER_UNACKNOWLEDGED;
                    } else {
                        if (!pending(context)) return Outcome.DEFERRED;
                        ActivityManager manager = context.getSystemService(ActivityManager.class);
                        outcome = manager != null && manager.clearApplicationUserData() ? Outcome.DISPATCHED : Outcome.ANDROID_REFUSED;
                    }
                } catch (RuntimeException failure) {
                    outcome = Outcome.ANDROID_REFUSED;
                }
                if (outcome != Outcome.DISPATCHED) recordFailure(context, count, first, outcome);
                return outcome;
            });
        } catch (Exception unavailable) {
            return Outcome.DEFERRED;
        }
    }

    /**
     * One attempt preceded by the host's {@link BeforeDispatch}, unless it already answered for
     * this reset. The step runs on a daemon worker and the attempt follows after at most
     * {@code timeoutMs}, so a slow or offline step never holds the reset; 0 skips the step.
     */
    public Outcome attemptWithRevocation(Context context, long now, long timeoutMs) {
        return admittedAttempt(context, now, true, timeoutMs);
    }

    private void runBoundedBeforeDispatch(Context context, long timeoutMs) {
        if (beforeDispatch == null || timeoutMs <= 0 || !pending(context) || revocationAnswered(context)) return;
        Thread worker = new Thread(() -> runBeforeDispatch(context, timeoutMs), "eliza-data-reset-before-dispatch");
        worker.setDaemon(true);
        worker.start();
        try {
            worker.join(timeoutMs);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Runs the host's bounded pre-dispatch work, only while a confirmed reset is pending and the
     * work has not already answered for it.
     */
    public void runBeforeDispatch(Context context, long timeoutMs) {
        if (beforeDispatch == null || timeoutMs <= 0) return;
        try {
            if (pending(context) && !revocationAnswered(context) && beforeDispatch.run(context, timeoutMs) && pending(context)) {
                write(answered(context), new byte[] {1});
            }
        } catch (Exception unavailable) {
            // Best effort by contract: the local reset proceeds.
        }
    }

    /**
     * After a fresh confirmation: run {@link BeforeDispatch} off the main thread and dispatch once,
     * when it returns or at {@code deadlineMs}, whichever is first. A failed, slow or offline step
     * never blocks or cancels the reset; the marker is already durable, so a crash here resumes on
     * the next launch.
     */
    public void dispatchAfterBeforeDispatch(Context context, long deadlineMs, Scheduler main) {
        final AtomicBoolean dispatched = new AtomicBoolean(false);
        final Runnable dispatch = () -> {
            if (dispatched.compareAndSet(false, true)) dispatchAndExit(context);
        };
        main.postDelayed(dispatch, deadlineMs);
        Thread worker = new Thread(() -> {
            try {
                runBeforeDispatch(context, deadlineMs - 500);
            } finally {
                main.post(dispatch);
            }
        }, "eliza-data-reset-before-dispatch");
        worker.setDaemon(true);
        worker.start();
    }

    /** The user just confirmed the reset, so an unfinished reset always opens recovery. */
    public void dispatchAndExit(Context context) {
        exit(context, true, true, 0);
    }

    /**
     * Startup admission, before any provider or initializer. Android also starts the process for
     * jobs, alarms, broadcasts, pushes, providers and bound services; opening recovery from such a
     * start would take the screen from the app in front. The process still stops; recovery opens
     * on the next activity start. When Android cannot say why the process started, recovery opens.
     */
    public void admitAndExit(Context context) {
        exit(context, visibleStart(context), false, 0);
    }

    private static boolean visibleStart(Context context) {
        try {
            return userVisibleStart(context);
        } catch (RuntimeException | LinkageError unknown) {
            return true;
        }
    }

    /** True in the host's provider-free recovery process. */
    public boolean isRecoveryProcess(Context context, String processName) {
        return (context.getPackageName() + recoveryProcessSuffix).equals(processName);
    }

    /**
     * Call first in {@code Application.attachBaseContext}, after {@code super}, before content
     * providers and startup initializers run. Returns normally when no reset is pending, in an
     * isolated process and in the recovery process; otherwise it never returns. The host's
     * {@link BeforeDispatch} runs only before an automatic attempt on a start the user is looking
     * at: a deferred or background start stops without waiting on the network.
     */
    public void admitBeforeStartup(Context context, String processName) {
        if (android.os.Process.isIsolated() || isRecoveryProcess(context, processName) || !pending(context)) return;
        boolean visible = visibleStart(context);
        exit(context, visible, false, visible ? STARTUP_BEFORE_DISPATCH_MS : 0);
    }

    private static boolean userVisibleStart(Context context) {
        if (android.os.Build.VERSION.SDK_INT < 35) return true;
        ActivityManager manager = context.getSystemService(ActivityManager.class);
        if (manager == null) return true;
        java.util.List<android.app.ApplicationStartInfo> starts = manager.getHistoricalProcessStartReasons(1);
        if (starts == null || starts.isEmpty() || starts.get(0).getPid() != android.os.Process.myPid()) return true;
        return !backgroundStart(starts.get(0).getReason());
    }

    public static boolean backgroundStart(int reason) {
        switch (reason) {
            case android.app.ApplicationStartInfo.START_REASON_ALARM:
            case android.app.ApplicationStartInfo.START_REASON_BACKUP:
            case android.app.ApplicationStartInfo.START_REASON_BOOT_COMPLETE:
            case android.app.ApplicationStartInfo.START_REASON_BROADCAST:
            case android.app.ApplicationStartInfo.START_REASON_CONTENT_PROVIDER:
            case android.app.ApplicationStartInfo.START_REASON_JOB:
            case android.app.ApplicationStartInfo.START_REASON_PUSH:
            case android.app.ApplicationStartInfo.START_REASON_SERVICE:
                return true;
            default:
                return false;
        }
    }

    /** Never resumes the old runtime, including when Android refuses or the Binder call fails. */
    private void exit(Context context, boolean showRecovery, boolean explicit, long beforeDispatchMs) {
        try {
            long now = System.currentTimeMillis();
            Outcome outcome = admittedAttempt(context, now, explicit, beforeDispatchMs);
            if (outcome != Outcome.DISPATCHED) {
                android.util.Log.w(logTag, "Reset not finished (" + outcome + ")" + (showRecovery ? "; showing recovery" : "; background start"));
                if (showRecovery) showRecovery(context);
            }
        } catch (RuntimeException failure) {
            android.util.Log.w(logTag, "Reset admission failed");
            if (showRecovery) showRecovery(context);
        } finally {
            android.os.Process.killProcess(android.os.Process.myPid());
            System.exit(0);
        }
    }

    private void showRecovery(Context context) {
        try {
            context.startActivity(new Intent(context, recoveryActivity).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        } catch (RuntimeException refused) {
            // The next launcher or HOME start shows it; data stays intact.
        }
    }
}
