package ai.eliza.plugins.system.reset;

import android.app.ActivityManager;
import android.app.ApplicationStartInfo;
import android.content.Context;
import ai.eliza.plugins.system.SenseListenerClient;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Host-JVM checks of the reset coordinator against Android stand-ins (see reset.test.mjs). */
public final class DataResetTest {
    static void check(boolean ok, String why) { if (!ok) throw new AssertionError(why); }

    static final class Recovery extends android.app.Activity {}

    static void stops(Runnable start, String why) {
        try { start.run(); throw new AssertionError(why); } catch (android.os.Process.Exit stopped) { /* expected */ }
    }

    public static void main(String[] args) throws Exception {
        // Child process for the cross-process lock check: holds the record lock while it bumps the count.
        if (args.length == 3 && args[0].equals("hold")) { holdAndBump(new File(args[1]), new File(args[2])); return; }
        authorization();
        copy();
        builder();
        dialer();
        coordinator(new File(args[0]), new File(args[1]));
        listenerPreflight(new File(args[0]));
        dispatchOrdering(new File(args[0]));
        interrupted(new File(args[0]));
        revocation(new File(args[0]));
        crossProcessLock(new File(args[0]));
        System.out.println("PASS data reset authorization, copy, admission, bounded recovery and dispatch ordering");
    }

    static void authorization() {
        ResetAuthorization reset = new ResetAuthorization();
        long one = reset.begin(); check(!reset.authenticate(one, true), "unconfirmed review cannot authorize");
        long two = reset.begin(); check(reset.confirm(two), "confirm"); check(!reset.authenticate(two, false), "failed unlock");
        long old = reset.begin(); check(reset.confirm(old), "confirm"); reset.retire(); check(!reset.authenticate(old, true), "retired");
        long now = reset.begin(); check(reset.confirm(now), "confirm"); check(!reset.authenticate(old, true), "stale token"); check(reset.authenticate(now, true), "fresh"); check(!reset.authenticate(now, true), "single use");
        long after = reset.begin();
        try { reset.begin(); throw new AssertionError("second concurrent review"); } catch (IllegalStateException expected) { /* one review */ }
        check(!reset.authenticate(after, true), "unconfirmed after busy");
        check(!new ResetAuthorization().authenticate(now, true), "a restarted plugin rejects an earlier token");
    }

    static void copy() {
        DataResetCopy text = DataResetCopy.forProduct("Example").build();
        check(text.reviewTitle.equals("Reset Example data?"), "title");
        check(text.disclosure.contains("There is no backup or undo"), "no backup disclosed");
        check(text.disclosure.contains("are not deleted or cancelled") && text.disclosure.contains("Other apps are not reset"), "scope disclosed");
        check(text.noScreenLock.equals("Set a device screen lock in Android before resetting Example data."), "lock");
        // Without a recorded failure the cause is unknown, never inferred from the listener.
        String unknown = text.recoveryBody(null, true, true), unknownOff = text.recoveryBody(null, false, true);
        for (String body : new String[] {unknown, unknownOff}) {
            check(body.contains("was not recorded") && !body.contains("listener") && !body.contains("Android has not accepted"), "unknown cause");
        }
        // The recorded outcome wins over the listener's current state.
        String refused = text.recoveryBody(DataReset.Outcome.ANDROID_REFUSED, true, true);
        check(refused.contains("Android has not accepted") && !refused.contains("confirmation has not arrived") && !refused.contains("listener's settings"), "refused after acknowledgement");
        String unacknowledged = text.recoveryBody(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, true, true);
        check(unacknowledged.contains("confirmation has not arrived") && unacknowledged.contains("open the listener's settings"), "recorded listener reason");
        String unreachable = text.recoveryBody(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, false, true);
        check(unreachable.contains("cannot reach the listener's controls") && !unreachable.contains("open the listener's settings"), "recorded, now unreachable");
        // A retry that Android refused after the listener was repaired names Android, not the listener.
        String retriedRefused = text.recoveryBody(DataReset.Outcome.ANDROID_REFUSED, true, true);
        check(retriedRefused.contains("Android has not accepted") && !retriedRefused.contains("listener"), "retry outcome names Android");
        for (String body : new String[] {unknown, unknownOff, refused, unacknowledged, unreachable}) {
            check(body.contains("has not been deleted yet") && body.endsWith("Phone and Android Settings remain available."), "never claims deletion");
            check(!body.matches("(?is).*(reset (is )?complete|data (was|has been) deleted\\.).*"), "no completion claim");
        }
        // No dialer outside this app: the body does not promise Phone.
        String noPhone = text.recoveryBody(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, true, false);
        check(!noPhone.contains("Phone") && noPhone.endsWith("Android Settings remains available."), "no Phone promise without a dialer");
        check(text.listenerOff.contains("nothing was reset"), "listener refusal says nothing was reset");
        check(text.retryResult(DataReset.Outcome.ANDROID_REFUSED, true).startsWith("Android did not accept"), "refused");
        check(text.retryResult(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, true).startsWith("The listener still has not confirmed"), "pending");
        check(text.retryResult(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, false).startsWith("The listener could not be reached"), "unreachable");
        check(text.retryResult(DataReset.Outcome.DISPATCHED, false).equals("Android is deleting Example's data. Example will close."), "dispatched");
        DataResetCopy custom = DataResetCopy.forProduct("Example").disclosure("Custom.").progressMessage("Signing out...").recoveryRemoteNote("(Remote note.)").build();
        check(custom.disclosure.equals("Custom.") && custom.progressMessage.equals("Signing out...") && custom.recoveryBody(null, false, true).contains("deleted yet. (Remote note.)\n\n"), "overrides");
        for (String invalid : new String[] {null, "", "   ", "x".repeat(61)}) {
            try { DataResetCopy.forProduct(invalid); throw new AssertionError("invalid product " + invalid); } catch (IllegalArgumentException expected) { /* rejected */ }
        }
    }

    static void dialer() {
        String self = "fixture.example";
        check(DataReset.recoveryDialer(self, "com.android.dialer", List.of(self, "other.dialer", "com.android.dialer")) == 2, "system dialer preferred");
        check(DataReset.recoveryDialer(self, self, List.of(self, "other.dialer")) == 1, "this app as system dialer is skipped");
        check(DataReset.recoveryDialer(self, null, List.of(self, "other.dialer")) == 1, "another handler");
        check(DataReset.recoveryDialer(self, self, List.of(self)) == -1, "only this app: no Phone button");
        check(DataReset.recoveryDialer(self, null, List.of()) == -1, "no handler");
    }

    /** A same-signer listener that is off or ungranted refuses before anything is recorded. */
    static void listenerPreflight(File data) throws Exception {
        Context.data = data;
        Context app = new Context();
        DataReset reset = DataReset.builder("reset-preflight", Recovery.class).build();
        SenseListenerClient.blocks = true;
        int listener = SenseListenerClient.calls, clears = ActivityManager.calls;
        try {
            check(!reset.recordIfListenerReachable(app), "unreachable listener refuses");
            check(!reset.pending(app) && !new File(data, "reset-preflight.pending").exists(), "no marker written");
            check(SenseListenerClient.calls == listener && ActivityManager.calls == clears, "nothing attempted");
        } finally {
            SenseListenerClient.blocks = false;
        }
        check(reset.recordIfListenerReachable(app) && reset.pending(app), "reachable listener records");
        new File(data, "reset-preflight.pending").delete();
        check(!reset.pending(app), "cleaned up");
    }

    static void builder() {
        for (String invalid : new String[] {null, "", "../reset", "Reset", "reset/example", "x".repeat(65)}) {
            try { DataReset.builder(invalid, Recovery.class); throw new AssertionError("invalid marker " + invalid); } catch (IllegalArgumentException expected) { /* rejected */ }
        }
        try { DataReset.builder("reset-x", null); throw new AssertionError("missing recovery"); } catch (IllegalArgumentException expected) { /* rejected */ }
        try { DataReset.builder("reset-x", Recovery.class).recoveryProcessSuffix("reset"); throw new AssertionError("suffix"); } catch (IllegalArgumentException expected) { /* rejected */ }
        try { DataReset.builder("reset-x", Recovery.class).logTag("x".repeat(24)); throw new AssertionError("tag"); } catch (IllegalArgumentException expected) { /* rejected */ }
    }

    static void coordinator(File data, File sibling) throws Exception {
        Context.data = data;
        Context app = new Context();
        List<String> order = new ArrayList<>();
        long[] budgets = {0};
        DataReset reset = DataReset.builder("reset-example", Recovery.class)
                .beforeDispatch((context, timeoutMs) -> { order.add("before"); budgets[0] = timeoutMs; })
                .build();
        SenseListenerClient.onReset = () -> order.add("listener");
        ActivityManager.onClear = () -> order.add("clear");
        check(!reset.pending(app), "nothing pending");
        // A stale attempt without a confirmed request touches neither the listener nor app data,
        // even when the listener would acknowledge and Android would accept.
        SenseListenerClient.acknowledged = true;
        int listenerBefore = SenseListenerClient.calls, clearsBefore = ActivityManager.calls;
        check(reset.attempt(app, System.currentTimeMillis()) == DataReset.Outcome.DEFERRED, "unconfirmed attempt");
        check(SenseListenerClient.calls == listenerBefore && ActivityManager.calls == clearsBefore, "no consent revocation or clear without confirmation");
        check(data.listFiles() == null || data.listFiles().length == 0, "no state recreated");
        // Nothing pending: startup admission returns and runs no host work.
        order.clear();
        reset.admitBeforeStartup(app, "fixture.example");
        check(order.isEmpty(), "no work without a confirmed reset");

        reset.record(app);
        check(reset.pending(app), "recorded");
        check(new File(data, "reset-example.pending").isFile(), "installed marker name");
        // Isolated helpers and the recovery process never stop themselves or retry.
        android.os.Process.isolated = true; reset.admitBeforeStartup(app, "fixture.example"); android.os.Process.isolated = false;
        check(reset.isRecoveryProcess(app, "fixture.example:reset_recovery") && !reset.isRecoveryProcess(app, "fixture.example"), "recovery process");
        reset.admitBeforeStartup(app, "fixture.example:reset_recovery");
        check(order.isEmpty() && ActivityManager.calls == 0, "recovery process runs nothing");

        // Accepted, refused and failed dispatch all stop the process before providers initialize.
        for (int mode = 0; mode < 3; mode++) {
            ActivityManager.mode = mode;
            order.clear();
            stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "providers would initialize");
            check(order.equals(List.of("before", "listener", "clear")), "host work, then listener, then Android: " + order);
            check(budgets[0] == DataReset.STARTUP_BEFORE_DISPATCH_MS, "startup budget");
            check(reset.pending(app), "fixture Android does not erase");
            // Each mode is its own launch history; an accepted clear that left data is covered below.
            Files.writeString(new File(data, "reset-example.failures").toPath(), "0:0");
        }
        check(ActivityManager.calls == 3, "three clears");

        // An installed listener that never acknowledges: Android relaunches HOME after each stop.
        // Every launch stops without clearing, shows recovery, and automatic attempts stay bounded.
        SenseListenerClient.acknowledged = false;
        File failures = new File(data, "reset-example.failures");
        Files.writeString(failures.toPath(), "0:0");
        Context.recoveries = 0; SenseListenerClient.calls = 0; int clears = ActivityManager.calls;
        for (int relaunch = 0; relaunch < 25; relaunch++) stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "unacknowledged reset resumed");
        check(Context.recoveries == 25, "recovery shown each visible launch");
        check(SenseListenerClient.calls == DataReset.AUTOMATIC_ATTEMPTS, "bounded automatic attempts: " + SenseListenerClient.calls);
        check(ActivityManager.calls == clears && reset.pending(app), "fail closed");
        // A missing legacy reservation cannot grant another automatic attempt.
        Files.delete(failures.toPath());
        check(reset.automaticAttempt(app, System.currentTimeMillis()) == DataReset.Outcome.DEFERRED, "missing reservation defers");
        check(SenseListenerClient.calls == DataReset.AUTOMATIC_ATTEMPTS, "missing reservation keeps listener fenced");
        try (var file = new java.io.RandomAccessFile(new File(data, "reset-example.lock"), "rw");
             var lease = file.getChannel().lock()) {
            check(reset.retry(app, System.currentTimeMillis()) == DataReset.Outcome.DEFERRED, "another process owns the attempt");
        }
        check(SenseListenerClient.calls == DataReset.AUTOMATIC_ATTEMPTS, "contending retry keeps listener fenced");
        // An exhausted start runs no host work: it does not wait on the network before stopping.
        order.clear();
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "deferred");
        check(!order.contains("before"), "deferred start skips host work: " + order);
        // A user's retry is a fresh attempt and still fails closed.
        check(reset.attempt(app, System.currentTimeMillis()) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "retry");
        check(SenseListenerClient.calls == DataReset.AUTOMATIC_ATTEMPTS + 1 && ActivityManager.calls == clears, "retry is fresh, no clear");

        // Window policy: the budget returns after the window or a clock change; unreadable state defers.
        long t = 1_000_000;
        check(DataReset.automaticAttemptAllowed(new long[] {0, 0}, t), "fresh");
        check(!DataReset.automaticAttemptAllowed(new long[] {DataReset.AUTOMATIC_ATTEMPTS, t}, t + 1), "exhausted");
        check(DataReset.automaticAttemptAllowed(new long[] {DataReset.AUTOMATIC_ATTEMPTS, t}, t + DataReset.AUTOMATIC_WINDOW_MS), "window over");
        check(DataReset.automaticAttemptAllowed(new long[] {DataReset.AUTOMATIC_ATTEMPTS, t}, t - 1), "clock moved back");
        for (String corrupt : new String[] {"garbage", "-1000000:" + System.currentTimeMillis(), "1:-5", "1:2:3", "99999999999:" + System.currentTimeMillis()}) {
            Files.write(failures.toPath(), corrupt.getBytes());
            check(!DataReset.automaticAttemptAllowed(reset.failureState(app), System.currentTimeMillis()), "corrupt " + corrupt);
        }
        SenseListenerClient.calls = 0;
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "deferred");
        check(SenseListenerClient.calls == 0 && reset.pending(app), "unreadable state defers automatic attempts");
        long before = System.currentTimeMillis();
        check(reset.attempt(app, before) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "user retry from unreadable state");
        long[] fresh = reset.failureState(app);
        check(fresh[0] == 1 && fresh[1] == before, "user retry starts a fresh window");
        check(reset.lastFailure(app) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "outcome recorded with the budget");
        // A record from a build before the outcome field keeps its budget and reports no outcome.
        Files.write(failures.toPath(), ("1:" + before).getBytes());
        check(reset.failureState(app)[0] == 1 && reset.lastFailure(app) == null, "two-part record");
        Files.write(failures.toPath(), ("1:" + before + ":DISPATCHED").getBytes());
        check(!DataReset.automaticAttemptAllowed(reset.failureState(app), before) && reset.lastFailure(app) == null, "a dispatched outcome is never a failure record");

        // Background starts stop without taking the screen; activity, unknown, stale and pre-35 starts show recovery.
        Files.writeString(failures.toPath(), "0:0");
        Object[][] starts = {
            {123, ApplicationStartInfo.START_REASON_JOB, false, 36, false}, {123, ApplicationStartInfo.START_REASON_SERVICE, false, 35, false},
            {123, ApplicationStartInfo.START_REASON_ALARM, false, 36, false}, {123, ApplicationStartInfo.START_REASON_BROADCAST, false, 36, false},
            {123, ApplicationStartInfo.START_REASON_PUSH, false, 36, false}, {123, ApplicationStartInfo.START_REASON_CONTENT_PROVIDER, false, 36, false},
            {123, ApplicationStartInfo.START_REASON_START_ACTIVITY, true, 36, false}, {123, ApplicationStartInfo.START_REASON_LAUNCHER, true, 36, false},
            {123, ApplicationStartInfo.START_REASON_OTHER, true, 36, false}, {999, ApplicationStartInfo.START_REASON_JOB, true, 36, false},
            {123, ApplicationStartInfo.START_REASON_JOB, true, 34, false}, {123, ApplicationStartInfo.START_REASON_JOB, true, 36, true},
        };
        for (Object[] start : starts) {
            ActivityManager.starts = List.of(new ApplicationStartInfo((Integer) start[0], (Integer) start[1]));
            android.os.Build.VERSION.SDK_INT = (Integer) start[3];
            ActivityManager.startsFail = (Boolean) start[4];
            int shown = Context.recoveries;
            order.clear();
            stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "background start resumed");
            check(Context.recoveries == shown + ((Boolean) start[2] ? 1 : 0), "visibility of start " + start[1] + " sdk " + start[3]);
            check(order.contains("before") == (Boolean) start[2], "host work only on a visible start: " + order);
            check(reset.pending(app) && ActivityManager.calls == clears, "fail closed");
            Files.writeString(failures.toPath(), "0:0");
        }
        // The interactive path follows the user's own confirmation, so it shows recovery whatever started the process.
        android.os.Build.VERSION.SDK_INT = 36; ActivityManager.startsFail = false;
        ActivityManager.starts = List.of(new ApplicationStartInfo(123, ApplicationStartInfo.START_REASON_JOB));
        int shown = Context.recoveries;
        stops(() -> reset.dispatchAndExit(app), "interactive");
        check(Context.recoveries == shown + 1, "interactive shows recovery");
        ActivityManager.starts = new ArrayList<>();
        // A duplicate record call cannot reset the budget. A newly confirmed dispatch can repair it.
        Files.writeString(failures.toPath(), "garbage");
        reset.record(app);
        check(Files.readString(failures.toPath()).equals("garbage"), "duplicate marker preserves the budget");
        stops(() -> reset.dispatchAndExit(app), "confirmed retry repairs the budget");
        check(reset.failureState(app)[0] == 1, "confirmed retry reserved a fresh window");
        // Acknowledged, then Android refused: the next launch completes without showing recovery.
        SenseListenerClient.acknowledged = true; ActivityManager.mode = 2;
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "refused");
        check(reset.pending(app), "refused keeps marker");
        check(reset.lastFailure(app) == DataReset.Outcome.ANDROID_REFUSED, "recovery explains the refusal, not the listener");
        ActivityManager.mode = 0; int recoveriesBefore = Context.recoveries;
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "accepted");
        check(Context.recoveries == recoveriesBefore, "accepted dispatch shows no recovery");
        // Simulated Android completion: only this fixture directory is erased.
        for (File file : data.listFiles()) check(file.delete(), "erase fixture");
        check(!reset.pending(app), "fresh data");
        SenseListenerClient.acknowledged = false;
        check(reset.attempt(app, System.currentTimeMillis()) == DataReset.Outcome.DEFERRED && data.listFiles().length == 0, "stale attempt after completion");
        SenseListenerClient.acknowledged = true;
        order.clear();
        reset.admitBeforeStartup(app, "fixture.example");
        check(order.isEmpty(), "fresh launch initializes normally");
        // Package-scoped: Android's own-package clear only; a sibling app's data is untouched.
        check(new File(sibling, "keep").isFile(), "sibling preserved");
    }

    /** Interactive dispatch happens once: after the host's work, or at the deadline when it hangs. */
    static void dispatchOrdering(File data) throws Exception {
        Context.data = data;
        Context app = new Context();
        final class Main implements DataReset.Scheduler {
            final List<Runnable> posted = new ArrayList<>(), delayed = new ArrayList<>();
            final List<Long> delays = new ArrayList<>();
            final CountDownLatch post = new CountDownLatch(1);
            @Override public synchronized void post(Runnable task) { posted.add(task); post.countDown(); }
            @Override public synchronized void postDelayed(Runnable task, long delayMs) { delayed.add(task); delays.add(delayMs); }
        }
        SenseListenerClient.acknowledged = true; ActivityManager.mode = 0;
        // Host work returns: its completion dispatches; the deadline later finds it already done.
        long[] budget = {0};
        DataReset quick = DataReset.builder("reset-example", Recovery.class).beforeDispatch((context, timeoutMs) -> budget[0] = timeoutMs).build();
        quick.record(app);
        int clears = ActivityManager.calls;
        Main main = new Main();
        quick.dispatchAfterBeforeDispatch(app, DataReset.INTERACTIVE_DEADLINE_MS, main);
        check(main.delays.equals(List.of(DataReset.INTERACTIVE_DEADLINE_MS)), "deadline armed first");
        check(main.post.await(5, TimeUnit.SECONDS), "host work completion posts dispatch");
        check(budget[0] == DataReset.INTERACTIVE_DEADLINE_MS - 500, "interactive budget leaves time to dispatch");
        stops(main.posted.get(0), "dispatch stops the process");
        check(ActivityManager.calls == clears + 1, "dispatched once");
        main.delayed.get(0).run();
        check(ActivityManager.calls == clears + 1, "deadline does not dispatch twice");

        // Host work hangs: the deadline dispatches, and the late completion does not dispatch again.
        CountDownLatch release = new CountDownLatch(1);
        DataReset hanging = DataReset.builder("reset-example", Recovery.class).beforeDispatch((context, timeoutMs) -> {
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }).build();
        hanging.record(app);
        Main slow = new Main();
        hanging.dispatchAfterBeforeDispatch(app, 1000, slow);
        stops(slow.delayed.get(0), "deadline dispatch");
        check(ActivityManager.calls == clears + 2, "deadline dispatched");
        release.countDown();
        check(slow.post.await(5, TimeUnit.SECONDS), "late completion posts");
        slow.posted.get(0).run();
        check(ActivityManager.calls == clears + 2, "late completion is ignored");

        // A throwing host step is contained; nothing pending means no host work at all.
        DataReset throwing = DataReset.builder("reset-example", Recovery.class).beforeDispatch((context, timeoutMs) -> { throw new IllegalStateException("offline"); }).build();
        throwing.runBeforeDispatch(app, 1000);
        for (File file : data.listFiles()) file.delete();
        boolean[] ran = {false};
        DataReset.builder("reset-example", Recovery.class).beforeDispatch((context, timeoutMs) -> ran[0] = true).build().runBeforeDispatch(app, 1000);
        check(!ran[0], "host work requires a durable confirmed reset");
    }

    static long[] count(File failures) throws Exception {
        String[] parts = new String(Files.readAllBytes(failures.toPath())).trim().split(":");
        return new long[] {Long.parseLong(parts[0]), Long.parseLong(parts[1])};
    }

    /** An attempt is counted before it starts, so dying mid-attempt cannot loop. */
    static void interrupted(File data) throws Exception {
        Context.data = data;
        Context app = new Context();
        for (File file : data.listFiles()) file.delete();
        DataReset reset = DataReset.builder("reset-example", Recovery.class).build();
        File failures = new File(data, "reset-example.failures");
        reset.record(app);
        // The listener call kills the process: the record already says an attempt started.
        SenseListenerClient.acknowledged = true; ActivityManager.mode = 0;
        boolean[] seen = {false};
        SenseListenerClient.onReset = () -> {
            try { seen[0] = new String(Files.readAllBytes(failures.toPath())).endsWith(":OPEN"); } catch (Exception e) { throw new AssertionError(e); }
            throw new android.os.Process.Exit();
        };
        try { reset.attempt(app, System.currentTimeMillis()); throw new AssertionError("process died"); } catch (android.os.Process.Exit died) { /* expected */ }
        SenseListenerClient.onReset = () -> {};
        check(seen[0] && count(failures)[0] == 1, "counted before the listener call");
        // The next start counts it as a failure, attempts nothing and shows recovery.
        int calls = SenseListenerClient.calls, shown = Context.recoveries;
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "interrupted");
        check(SenseListenerClient.calls == calls && Context.recoveries == shown + 1, "start after an interrupted attempt defers");
        check(reset.failureState(app)[0] == 1 && reset.lastFailure(app) == null && !new String(Files.readAllBytes(failures.toPath())).contains("OPEN"), "interrupted attempt closed: one failure");
        // The budget still applies to later starts.
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "resumed");
        check(SenseListenerClient.calls == calls + 1, "next start attempts again");
        // An accepted clear whose deletion did not finish leaves the record OPEN; the next start defers.
        check(new String(Files.readAllBytes(failures.toPath())).endsWith(":OPEN") && count(failures)[0] == 2, "dispatched stays open");
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "clear did not finish");
        check(SenseListenerClient.calls == calls + 1 && reset.pending(app), "unfinished clear defers to recovery");
        // Records from earlier builds still parse.
        long now = System.currentTimeMillis();
        Files.write(failures.toPath(), ("2:" + now).getBytes());
        check(reset.failureState(app)[0] == 2 && reset.lastFailure(app) == null, "two-part legacy record");
        Files.write(failures.toPath(), ("1:" + now + ":ANDROID_REFUSED").getBytes());
        check(reset.failureState(app)[0] == 1 && reset.lastFailure(app) == DataReset.Outcome.ANDROID_REFUSED, "three-part legacy record");
        // The listener step throwing is the listener's failure, not Android's.
        SenseListenerClient.failure = new IllegalStateException("binder died");
        int clears = ActivityManager.calls;
        check(reset.attempt(app, now) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "listener exception");
        SenseListenerClient.failure = null;
        check(ActivityManager.calls == clears && reset.lastFailure(app) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "recorded as the listener's");
        for (File file : data.listFiles()) file.delete();
    }

    /** Pre-dispatch work stops once answered, and the recovery retry runs it within its budget. */
    static void revocation(File data) throws Exception {
        Context.data = data;
        Context app = new Context();
        for (File file : data.listFiles()) file.delete();
        List<String> order = new ArrayList<>();
        boolean[] reachable = {false};
        DataReset reset = DataReset.builder("reset-example", Recovery.class)
                .beforeDispatchAnswered((context, timeoutMs) -> { synchronized (order) { order.add("revoke"); } return reachable[0]; })
                .build();
        SenseListenerClient.onReset = () -> { synchronized (order) { order.add("listener"); } };
        ActivityManager.onClear = () -> { synchronized (order) { order.add("clear"); } };
        SenseListenerClient.acknowledged = false;
        reset.record(app);
        // Offline: no answer, so the user's retry asks again; reachable: revoked before the clear.
        reset.attemptWithRevocation(app, System.currentTimeMillis(), DataReset.INTERACTIVE_DEADLINE_MS);
        check(order.equals(List.of("revoke", "listener")) && !reset.revocationAnswered(app), "offline retry: " + order);
        order.clear(); reachable[0] = true; SenseListenerClient.acknowledged = true; ActivityManager.mode = 1;
        reset.attemptWithRevocation(app, System.currentTimeMillis(), DataReset.INTERACTIVE_DEADLINE_MS);
        check(order.equals(List.of("revoke", "listener", "clear")) && reset.revocationAnswered(app), "retry revokes before clearing: " + order);
        // Answered once: later starts and retries do not send the key again.
        order.clear(); Files.writeString(new File(data, "reset-example.failures").toPath(), "0:0");
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "startup");
        reset.attemptWithRevocation(app, System.currentTimeMillis(), DataReset.INTERACTIVE_DEADLINE_MS);
        check(order.equals(List.of("listener", "clear", "listener", "clear")), "answered revocation is not repeated: " + order);
        // A completed reset followed by a new confirmation asks again.
        new File(data, "reset-example.pending").delete();
        reset.record(app);
        check(!reset.revocationAnswered(app), "new confirmation clears the answer");
        // A step that never returns cannot hold the retry past its budget.
        CountDownLatch release = new CountDownLatch(1);
        DataReset hanging = DataReset.builder("reset-example", Recovery.class).beforeDispatch((context, timeoutMs) -> {
            try { release.await(30, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }).build();
        long started = System.nanoTime();
        hanging.attemptWithRevocation(app, System.currentTimeMillis(), 300);
        check((System.nanoTime() - started) / 1_000_000L < 5_000, "retry never hangs");
        release.countDown();
        SenseListenerClient.onReset = () -> {}; ActivityManager.onClear = () -> {}; ActivityManager.mode = 0;
        for (File file : data.listFiles()) file.delete();
    }

    static void holdAndBump(File lock, File failures) throws Exception {
        try (java.io.RandomAccessFile file = new java.io.RandomAccessFile(lock, "rw"); java.nio.channels.FileLock held = file.getChannel().lock()) {
            long[] state = count(failures);
            System.out.println("locked");
            System.out.flush();
            new java.io.BufferedReader(new java.io.InputStreamReader(System.in)).readLine();
            Files.write(failures.toPath(), ((state[0] + 1) + ":" + state[1] + ":ANDROID_REFUSED").getBytes());
        }
    }

    /** Another process's update in progress holds this one off, so the count never goes back. */
    static void crossProcessLock(File data) throws Exception {
        Context.data = data;
        Context app = new Context();
        for (File file : data.listFiles()) file.delete();
        DataReset reset = DataReset.builder("reset-example", Recovery.class).build();
        reset.record(app);
        File failures = new File(data, "reset-example.failures");
        long first = System.currentTimeMillis();
        Files.write(failures.toPath(), ("1:" + first + ":LISTENER_UNACKNOWLEDGED").getBytes());
        Process other = new ProcessBuilder(ProcessHandle.current().info().command().orElse("java"), "-cp", System.getProperty("java.class.path"),
                DataResetTest.class.getName(), "hold", new File(data, "reset-example.lock").getPath(), failures.getPath()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        try {
            check("locked".equals(new java.io.BufferedReader(new java.io.InputStreamReader(other.getInputStream())).readLine()), "other process holds the lock");
            SenseListenerClient.acknowledged = false;
            java.util.concurrent.atomic.AtomicReference<DataReset.Outcome> result = new java.util.concurrent.atomic.AtomicReference<>();
            Thread attempt = new Thread(() -> result.set(reset.attempt(app, first + 1)));
            attempt.start();
            attempt.join(300);
            check(!attempt.isAlive() && result.get() == DataReset.Outcome.DEFERRED, "contending attempt defers without effects");
            other.getOutputStream().write('\n');
            other.getOutputStream().flush();
            attempt.join(10_000);
            check(!attempt.isAlive() && other.waitFor(10, TimeUnit.SECONDS) && other.exitValue() == 0, "both finished");
            check(count(failures)[0] == 2 && count(failures)[1] == first, "only the admitted process changed the count");
            check(reset.attempt(app, first + 1) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "retry after the other process releases");
            check(count(failures)[0] == 3 && count(failures)[1] == first, "both admitted attempts counted: " + new String(Files.readAllBytes(failures.toPath())));
        } finally {
            other.destroyForcibly();
            for (File file : data.listFiles()) file.delete();
        }
    }
}
