package ai.eliza.plugins.system.clock;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.TreeSet;

/**
 * Repeat days for an Android Clock handoff, as {@code java.util.Calendar} values (SUNDAY=1 …
 * SATURDAY=7), the values {@code AlarmClock.EXTRA_DAYS} takes. Three admissions, all exact:
 *
 * <ul>
 *   <li>{@link #strict}: a host's own Clock form. One to seven days, unique and ascending; anything
 *       else is refused rather than repaired.
 *   <li>{@link #agent}: an agent operation, as the shared {@code clock-contract.ts}
 *       ({@code clockDays}) admits it: at most seven, any order. Sorted and de-duplicated; an explicit
 *       empty list is a one-time alarm and returns null, the same as omitted days.
 *   <li>{@link #explicit}: a reviewed request that keeps the caller's order; unique, possibly empty
 *       (one-time), returned unmodifiable.
 * </ul>
 *
 * No Android types: host-tested on a plain JVM.
 */
public final class ClockDays {
    public static final String INVALID = "Choose valid repeat days";
    private static final String[] NAMES = {"", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

    private ClockDays() {}

    /** A JSON value (null, {@code JSONObject.NULL} or a {@code JSONArray}) for {@link #strict(List)}. */
    public static ArrayList<Integer> strict(Object raw) {
        List<Integer> days = fromJson(raw, 1);
        return days == null ? null : strict(days);
    }

    public static ArrayList<Integer> strict(List<Integer> input) {
        if (input == null) return null;
        ArrayList<Integer> out = new ArrayList<>();
        for (Integer day : input) {
            if (day == null || day < 1 || day > 7 || (!out.isEmpty() && day <= out.get(out.size() - 1)))
                throw new IllegalArgumentException(INVALID);
            out.add(day);
        }
        if (out.isEmpty()) throw new IllegalArgumentException(INVALID);
        return out;
    }

    /** An agent operation's days: sorted, de-duplicated, and null for omitted or empty. */
    public static ArrayList<Integer> agent(Object raw) {
        List<Integer> days = fromJson(raw, 0);
        if (days == null) return null;
        TreeSet<Integer> sorted = new TreeSet<>(days);
        return sorted.isEmpty() ? null : new ArrayList<>(sorted);
    }

    /** A reviewed request's days in the caller's order: unique values 1..7, possibly empty. */
    public static List<Integer> explicit(List<Integer> input) {
        if (input == null) throw new IllegalArgumentException(INVALID);
        List<Integer> copy = new ArrayList<>(input);
        boolean[] seen = new boolean[8];
        for (Integer day : copy) {
            if (day == null || day < 1 || day > 7 || seen[day]) throw new IllegalArgumentException(INVALID);
            seen[day] = true;
        }
        return Collections.unmodifiableList(copy);
    }

    /** Short English day names, for example "Mon, Wed". */
    public static String names(List<Integer> days) {
        StringBuilder out = new StringBuilder();
        for (Integer day : days) {
            if (day == null || day < 1 || day > 7) throw new IllegalArgumentException(INVALID);
            if (out.length() > 0) out.append(", ");
            out.append(NAMES[day]);
        }
        return out.toString();
    }

    private static List<Integer> fromJson(Object raw, int minimum) {
        if (raw == null || raw == org.json.JSONObject.NULL) return null;
        if (!(raw instanceof org.json.JSONArray)) throw new IllegalArgumentException(INVALID);
        org.json.JSONArray input = (org.json.JSONArray) raw;
        if (input.length() < minimum || input.length() > 7) throw new IllegalArgumentException(INVALID);
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < input.length(); i++) out.add(day(input.opt(i)));
        return out;
    }

    private static int day(Object value) {
        if (!(value instanceof Number)) throw new IllegalArgumentException(INVALID);
        double n = ((Number) value).doubleValue();
        if (!Double.isFinite(n) || n != Math.rint(n) || n < 1 || n > 7) throw new IllegalArgumentException(INVALID);
        return (int) n;
    }
}
