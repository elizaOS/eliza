package ai.elizaos.app;

import java.time.Instant;
import java.time.ZoneId;
import java.util.List;

/** Real production wall-clock recurrence boundaries; this does not prove Android delivery or sound. */
public final class ElizaAlarmScheduleTest {
    private static int checks;
    private static long at(String instant) { return Instant.parse(instant).toEpochMilli(); }
    private static void next(String now, int hour, int minute, List<Integer> days, String zone, String expected) {
        long actual = ElizaAlarmSchedule.next(at(now), hour, minute, days, ZoneId.of(zone));
        if (actual != at(expected)) throw new AssertionError("Expected " + expected + ", got " + Instant.ofEpochMilli(actual));
        checks++;
    }
    private static void rejects(Runnable operation) {
        try { operation.run(); } catch (IllegalArgumentException expected) { checks++; return; }
        throw new AssertionError("Invalid recurrence admitted");
    }
    public static void main(String[] args) {
        List<Integer> daily = List.of(1, 2, 3, 4, 5, 6, 7), weekdays = List.of(2, 3, 4, 5, 6);
        next("2026-10-06T15:59:59Z", 9, 0, daily, "America/Los_Angeles", "2026-10-06T16:00:00Z");
        next("2026-10-06T16:00:00Z", 9, 0, daily, "America/Los_Angeles", "2026-10-07T16:00:00Z");
        next("2026-10-09T16:00:00Z", 9, 0, weekdays, "America/Los_Angeles", "2026-10-12T16:00:00Z");
        next("2026-10-07T16:00:00Z", 9, 0, List.of(2, 4, 6), "America/Los_Angeles", "2026-10-09T16:00:00Z");
        next("2026-10-06T16:00:00Z", 9, 0, List.of(3), "America/Los_Angeles", "2026-10-13T16:00:00Z");
        next("2026-10-06T16:00:00Z", 9, 0, List.of(), "America/Los_Angeles", "2026-10-07T16:00:00Z");
        // Spring: the next 09:00 is only 23 elapsed hours later, and skipped 02:30 becomes 03:30.
        next("2026-03-07T17:00:00Z", 9, 0, daily, "America/Los_Angeles", "2026-03-08T16:00:00Z");
        next("2026-03-08T08:00:00Z", 2, 30, daily, "America/Los_Angeles", "2026-03-08T10:30:00Z");
        // Fall: first 01:30 only; creating after that occurrence schedules tomorrow, not its duplicate.
        next("2026-11-01T07:00:00Z", 1, 30, daily, "America/Los_Angeles", "2026-11-01T08:30:00Z");
        next("2026-11-01T08:45:00Z", 1, 30, daily, "America/Los_Angeles", "2026-11-02T09:30:00Z");
        next("2026-10-31T16:00:00Z", 9, 0, daily, "America/Los_Angeles", "2026-11-01T17:00:00Z");
        // Follow-phone semantics: the same 09:00 wall-clock definition moves with the local zone.
        next("2026-10-06T12:00:00Z", 9, 0, daily, "America/New_York", "2026-10-06T13:00:00Z");
        next("2026-10-06T12:00:00Z", 9, 0, daily, "America/Los_Angeles", "2026-10-06T16:00:00Z");
        rejects(() -> ElizaAlarmSchedule.days(List.of(2, 2)));
        rejects(() -> ElizaAlarmSchedule.days(List.of(0)));
        rejects(() -> ElizaAlarmSchedule.days(List.of(8)));
        rejects(() -> ElizaAlarmSchedule.days(null));
        rejects(() -> ElizaAlarmSchedule.validate(24, 0, ""));
        rejects(() -> ElizaAlarmSchedule.validate(0, 60, ""));
        rejects(() -> ElizaAlarmSchedule.validate(9, 0, "line\n"));
        System.out.println("Native wall-clock recurrence boundary checks passed: " + checks);
    }
}
