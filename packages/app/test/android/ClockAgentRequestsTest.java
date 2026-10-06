package ai.elizaos.app;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Deterministic production admission/cancellation policy. Queued callbacks never contact an agent. */
public final class ClockAgentRequestsTest {
    private static int checks;
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    private static void rejects(Runnable operation) {
        try { operation.run(); } catch (RuntimeException expected) { checks++; return; }
        throw new AssertionError("Cancelled/closed native request admitted");
    }
    public static void main(String[] args) {
        AtomicLong time = new AtomicLong(1000); Object owner = new Object(), other = new Object();
        ClockAgentRequests requests = new ClockAgentRequests(time::get, 4);
        requests.cancel("before-admission"); requests.cancel("before-admission");
        rejects(() -> requests.begin("before-admission", owner));
        ClockAgentRequests.Entry queued = requests.begin("queued-enrollment", owner);
        AtomicInteger effects = new AtomicInteger(), disconnects = new AtomicInteger();
        Runnable delayedEnrollmentAndChat = () -> { queued.current(owner); effects.incrementAndGet(); };
        requests.cancel("queued-enrollment"); rejects(delayedEnrollmentAndChat);
        check(effects.get() == 0, "Successful cancellation must suppress later enrollment/chat work");
        queued.connected(disconnects::incrementAndGet);
        check(disconnects.get() == 1, "Cancelled queued ticket must close a later connection");
        queued.finish();
        rejects(() -> requests.begin("queued-enrollment", owner));
        ClockAgentRequests.Entry buffered = requests.begin("buffered", owner);
        buffered.connected(disconnects::incrementAndGet); requests.cancel("buffered");
        rejects(() -> buffered.current(owner));
        check(disconnects.get() == 2, "Buffered requests must cancel their connection too");
        buffered.finish();
        ClockAgentRequests.Entry stream = requests.begin("stream", owner);
        rejects(() -> stream.current(other));
        requests.cancelOwner(owner); rejects(() -> stream.current(owner));
        stream.finish();
        rejects(() -> requests.begin("budget", owner));
        rejects(() -> requests.cancel("budget"));
        time.set(601001);
        ClockAgentRequests.Entry afterCleanup = requests.begin("new-owner", other);
        afterCleanup.current(other); checks++;
        afterCleanup.finish(); rejects(() -> afterCleanup.current(other));
        ClockAgentRequests.Entry deadline = requests.begin("deadline", other);
        time.addAndGet(300000); rejects(() -> deadline.current(other));
        deadline.finish();
        check(effects.get() == 0, "Admission/cancellation must perform no synthetic effects");
        System.out.println("Native agent cancellation passed: " + checks + " checks; no HTTP, credentials, Android UI or device effects");
    }
}
