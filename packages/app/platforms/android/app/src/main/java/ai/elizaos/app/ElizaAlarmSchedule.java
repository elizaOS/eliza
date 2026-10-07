package ai.elizaos.app;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Phone-local wall-clock recurrence. Recompute each date instead of adding 24 hours. */
final class ElizaAlarmSchedule {
    private ElizaAlarmSchedule() {}

    static List<Integer> days(List<Integer> requested) {
        if (requested == null) throw new IllegalArgumentException("Alarm repeat days required");
        ArrayList<Integer> result = new ArrayList<>(requested);
        boolean[] seen = new boolean[8];
        for (Integer day : result) {
            if (day == null || day < 1 || day > 7 || seen[day])
                throw new IllegalArgumentException("Invalid alarm repeat days");
            seen[day] = true;
        }
        Collections.sort(result);
        return Collections.unmodifiableList(result);
    }

    static void validate(int hour, int minute, String label) {
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
            throw new IllegalArgumentException("Invalid alarm time");
        if (label == null || label.length() > 200
                || label.chars().anyMatch(c -> c < 32 || c == 127))
            throw new IllegalArgumentException("Invalid alarm label");
    }

    /** A nonexistent DST time moves forward by the gap; an overlap uses its first occurrence. */
    static long next(long after, int hour, int minute, List<Integer> days, ZoneId zone) {
        validate(hour, minute, "");
        List<Integer> repeat = days(days);
        LocalDate today = Instant.ofEpochMilli(after).atZone(zone).toLocalDate();
        for (int offset = 0; offset <= 7; offset++) {
            LocalDate date = today.plusDays(offset);
            int calendarDay = date.getDayOfWeek().getValue() % 7 + 1;
            if (!repeat.isEmpty() && !repeat.contains(calendarDay)) continue;
            long candidate = LocalDateTime.of(date, LocalTime.of(hour, minute))
                    .atZone(zone).withEarlierOffsetAtOverlap().toInstant().toEpochMilli();
            if (candidate > after) return candidate;
        }
        throw new IllegalStateException("Alarm recurrence has no next date");
    }
}
