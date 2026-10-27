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
        authorization();
        copy();
        builder();
        coordinator(new File(args[0]), new File(args[1]));
        dispatchOrdering(new File(args[0]));
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
        String absent = text.recoveryBody(false, false), pending = text.recoveryBody(true, true), unreachable = text.recoveryBody(true, false);
        check(absent.contains("Android has not accepted") && !absent.contains("listener's settings"), "android reason");
        check(pending.contains("confirmation has not arrived") && pending.contains("open the listener's settings"), "listener pending reason");
        check(unreachable.contains("cannot reach the listener's controls") && !unreachable.contains("open the listener's settings"), "unreachable reason");
        for (String body : new String[] {absent, pending, unreachable}) {
            check(body.contains("has not been deleted yet") && body.endsWith("Phone and Android Settings remain available."), "never claims deletion");
            check(!body.matches("(?is).*(reset (is )?complete|data (was|has been) deleted\\.).*"), "no completion claim");
        }
        check(text.retryResult(DataReset.Outcome.ANDROID_REFUSED, true).startsWith("Android did not accept"), "refused");
        check(text.retryResult(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, true).startsWith("The listener still has not confirmed"), "pending");
        check(text.retryResult(DataReset.Outcome.LISTENER_UNACKNOWLEDGED, false).startsWith("The listener could not be reached"), "unreachable");
        check(text.retryResult(DataReset.Outcome.DISPATCHED, false).equals("Android is deleting Example's data. Example will close."), "dispatched");
        DataResetCopy custom = DataResetCopy.forProduct("Example").disclosure("Custom.").progressMessage("Signing out...").recoveryRemoteNote("(Remote note.)").build();
        check(custom.disclosure.equals("Custom.") && custom.progressMessage.equals("Signing out...") && custom.recoveryBody(false, false).contains("deleted yet. (Remote note.)\n\n"), "overrides");
        for (String invalid : new String[] {null, "", "   ", "x".repeat(61)}) {
            try { DataResetCopy.forProduct(invalid); throw new AssertionError("invalid product " + invalid); } catch (IllegalArgumentException expected) { /* rejected */ }
        }
    }

    static void builder() {
        for (String invalid : new String[] {null, "", "../reset", "Reset", "reset/alpha", "x".repeat(65)}) {
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
        // A late failure from a stale recovery attempt cannot recreate reset state in fresh data.
        SenseListenerClient.acknowledged = false;
        check(reset.attempt(app, System.currentTimeMillis()) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED, "late failure");
        check(data.listFiles() == null || data.listFiles().length == 0, "no state recreated");
        SenseListenerClient.acknowledged = true;
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
        }
        check(ActivityManager.calls == 3, "three clears");

        // An installed listener that never acknowledges: Android relaunches HOME after each stop.
        // Every launch stops without clearing, shows recovery, and automatic attempts stay bounded.
        SenseListenerClient.acknowledged = false;
        File failures = new File(data, "reset-example.failures");
        failures.delete();
        Context.recoveries = 0; SenseListenerClient.calls = 0; int clears = ActivityManager.calls;
        for (int relaunch = 0; relaunch < 25; relaunch++) stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "unacknowledged reset resumed");
        check(Context.recoveries == 25, "recovery shown each visible launch");
        check(SenseListenerClient.calls == DataReset.AUTOMATIC_ATTEMPTS, "bounded automatic attempts: " + SenseListenerClient.calls);
        check(ActivityManager.calls == clears && reset.pending(app), "fail closed");
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

        // Background starts stop without taking the screen; activity, unknown, stale and pre-35 starts show recovery.
        check(failures.delete(), "reset budget");
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
            stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "background start resumed");
            check(Context.recoveries == shown + ((Boolean) start[2] ? 1 : 0), "visibility of start " + start[1] + " sdk " + start[3]);
            check(reset.pending(app) && ActivityManager.calls == clears, "fail closed");
            failures.delete();
        }
        // The interactive path follows the user's own confirmation, so it shows recovery whatever started the process.
        android.os.Build.VERSION.SDK_INT = 36; ActivityManager.startsFail = false;
        ActivityManager.starts = List.of(new ApplicationStartInfo(123, ApplicationStartInfo.START_REASON_JOB));
        int shown = Context.recoveries;
        stops(() -> reset.dispatchAndExit(app), "interactive");
        check(Context.recoveries == shown + 1, "interactive shows recovery");
        ActivityManager.starts = new ArrayList<>();
        // A new confirmation starts a fresh budget, so the interactive attempt is never silently deferred.
        Files.write(failures.toPath(), "garbage".getBytes());
        reset.record(app);
        check(!failures.exists() && DataReset.automaticAttemptAllowed(reset.failureState(app), System.currentTimeMillis()), "fresh budget");
        // Acknowledged, then Android refused: the next launch completes without showing recovery.
        SenseListenerClient.acknowledged = true; ActivityManager.mode = 2;
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "refused");
        check(reset.pending(app), "refused keeps marker");
        ActivityManager.mode = 0; int recoveriesBefore = Context.recoveries;
        stops(() -> reset.admitBeforeStartup(app, "fixture.example"), "accepted");
        check(Context.recoveries == recoveriesBefore, "accepted dispatch shows no recovery");
        // Simulated Android completion: only this fixture directory is erased.
        for (File file : data.listFiles()) check(file.delete(), "erase fixture");
        check(!reset.pending(app), "fresh data");
        SenseListenerClient.acknowledged = false;
        check(reset.attempt(app, System.currentTimeMillis()) == DataReset.Outcome.LISTENER_UNACKNOWLEDGED && data.listFiles().length == 0, "late failure after completion");
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
}
