/** Runs production native request validation on the JVM; Android activity launch and ringing remain untested. */
package ai.elizaos.app;

public final class ClockHandoffRequestTest {
    private static int checks;
    private static void rejects(Runnable operation) {
        try { operation.run(); } catch (RuntimeException expected) { checks++; return; }
        throw new AssertionError("Invalid native request admitted");
    }
    public static void main(String[] args) {
        ClockHandoff.Request request = ClockHandoff.Request.set(23, 59, "Wake up", "America/Los_Angeles");
        request.requireCurrentTimeZone("America/Los_Angeles"); checks++;
        rejects(() -> request.requireCurrentTimeZone("UTC"));
        rejects(() -> ClockHandoff.Request.set(-1, 0, "", "UTC"));
        rejects(() -> ClockHandoff.Request.set(24, 0, "", "UTC"));
        rejects(() -> ClockHandoff.Request.set(0, 60, "", "UTC"));
        rejects(() -> ClockHandoff.Request.set(0, -1, "", "UTC"));
        rejects(() -> ClockHandoff.Request.set(0, 0, "x".repeat(201), "UTC"));
        rejects(() -> ClockHandoff.Request.set(0, 0, "newline\n", "UTC"));
        rejects(() -> ClockHandoff.Request.set(0, 0, "", "Unknown/Zone"));
        rejects(() -> ClockHandoff.Request.set(0, 0, "", "GMT+01:00"));
        rejects(() -> ClockHandoff.Request.snooze(0));
        rejects(() -> ClockHandoff.Request.snooze(61));
        if (ClockHandoff.Request.snooze(60).snoozeMinutes != 60) throw new AssertionError(); checks++;
        if (ClockHandoff.Request.show().action != ClockHandoff.Action.SHOW) throw new AssertionError(); checks++;
        if (ClockHandoff.Request.dismiss().action != ClockHandoff.Action.DISMISS) throw new AssertionError(); checks++;
        System.out.println("Native request checks passed: " + checks + "; no Android dispatch performed");
    }
}
