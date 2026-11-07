/** Runs production native request validation on the JVM; Android activity launch and ringing remain untested. */
package ai.elizaos.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

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
        if (request.days != null) throw new AssertionError("Legacy repeat must remain omitted"); checks++;
        List<Integer> weekdays = new ArrayList<>(List.of(2, 3, 4, 5, 6));
        ClockHandoff.Request recurring = ClockHandoff.Request.set(9, 0, "Weekdays", "UTC", weekdays);
        weekdays.clear();
        if (!recurring.days.equals(List.of(2, 3, 4, 5, 6))) throw new AssertionError("Caller changed repeat"); checks++;
        rejects(() -> recurring.days.add(1));
        rejects(() -> ClockHandoff.Request.set(9, 0, "", "UTC", null));
        rejects(() -> ClockHandoff.Request.set(9, 0, "", "UTC", Arrays.asList(2, null)));
        rejects(() -> ClockHandoff.Request.set(9, 0, "", "UTC", List.of(0)));
        rejects(() -> ClockHandoff.Request.set(9, 0, "", "UTC", List.of(8)));
        rejects(() -> ClockHandoff.Request.set(9, 0, "", "UTC", List.of(2, 2)));
        ClockHandoff.Request once = ClockHandoff.Request.set(9, 0, "Once", "UTC", List.of());
        if (once.days == null || !once.days.isEmpty()) throw new AssertionError("Explicit one-off lost"); checks++;
        List<Integer> daily = List.of(1, 2, 3, 4, 5, 6, 7);
        if (!ClockHandoff.Request.set(9, 0, "Daily", "UTC", daily).days.equals(daily)) throw new AssertionError(); checks++;
        List<Integer> custom = List.of(7, 1, 3);
        if (!ClockHandoff.Request.set(9, 0, "Custom", "UTC", custom).days.equals(custom))
            throw new AssertionError("Exact repeat order lost"); checks++;
        String review = ClockReviewDialog.description(recurring);
        if (!review.contains("Monday, Tuesday, Wednesday, Thursday, Friday (every week)")
                || !review.contains("Clock owns this alarm and its repeat schedule")) throw new AssertionError("Incomplete review"); checks++;
        review = ClockReviewDialog.description(ClockHandoff.Request.set(9, 0, "Daily", "UTC", daily));
        if (!review.contains("Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday")) throw new AssertionError(); checks++;
        if (!ClockReviewDialog.description(once).contains("Once (no repeat days)")) throw new AssertionError(); checks++;
        for (ClockHandoff.Request broad : List.of(ClockHandoff.Request.dismiss(), ClockHandoff.Request.snooze(10))) {
            String description = ClockReviewDialog.description(broad);
            if (!description.contains("all ringing alarms") || !description.contains("No specific alarm is selected")
                    || !description.contains("may act immediately") || !description.contains("No second confirmation is guaranteed"))
                throw new AssertionError("Targetless native consent must disclose its full scope");
            checks++;
        }
        if (!ClockReviewDialog.description(ClockHandoff.Request.snooze(10)).contains("default duration or show a chooser"))
            throw new AssertionError("Snooze consent must not promise exact handler behavior");
        checks++;
        System.out.println("Native request checks passed: " + checks + "; no Android dispatch performed");
    }
}
