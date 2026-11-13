package ai.eliza.voice;

import ai.eliza.voice.RecognizerAvailability.Answer;
import ai.eliza.voice.RecognizerAvailability.Known;
import java.util.function.Consumer;

/**
 * Every state of the recognizer availability policy against every event, on a fake clock. A row
 * is a state, built from nothing by real calls; a column is one event. A cell is what is known
 * after the event ({@code -} unknown, {@code I} installed, {@code A} absent, {@code U} unanswered,
 * {@code D} demoted), with {@code *} when the event asked the recognition service.
 */
public final class RecognizerAvailabilityTest {
    static final long ABSENT_FOR = 60, RETRY_AFTER = 30, DEMOTE_FOR = 300, FAR = 1_000_000_000L;
    static final String L = "es-US";
    static long now;

    static final String[] COLUMNS = {
        "probe:I", "probe:A", "probe:U", "late:I", "late:A", "late:U", "demote", "demote300", "demoteAll", "far",
    };

    // state                  probe:I probe:A probe:U late:I late:A late:U demote demote300 demoteAll far
    static final String[] TABLE = {
        "unknown                  I*  A*  U*   I  A  U   D  D  D   -",
        "installed                I   I   I    I  A  I   D  D  D   I",
        "absent                   A   A   A    I  A  A   D  D  D   -",
        "absent-at-59             A   A   A    I  A  A   D  D  D   -",
        "absent-expired           I*  A*  U*   I  A  U   D  D  D   -",
        "unanswered               U   U   U    I  A  U   D  D  D   -",
        "unanswered-at-29         U   U   U    I  A  U   D  D  D   -",
        "unanswered-expired       I*  A*  U*   I  A  U   D  D  D   -",
        "demoted                  D   D   D    D  D  D   D  D  D   D",
        "demoted-for              D   D   D    D  D  D   D  D  D   -",
        "demoted-for-expired      I*  A*  U*   I  A  U   D  D  D   -",
        "demoted-all              D   D   D    D  D  D   D  D  D   D",
    };

    static Consumer<RecognizerAvailability> state(String name) {
        switch (name) {
            case "unknown": return policy -> {};
            case "installed": return policy -> policy.record(L, Answer.INSTALLED);
            case "absent": return policy -> policy.record(L, Answer.ABSENT);
            case "absent-at-59": return policy -> { policy.record(L, Answer.ABSENT); now += ABSENT_FOR - 1; };
            case "absent-expired": return policy -> { policy.record(L, Answer.ABSENT); now += ABSENT_FOR; };
            case "unanswered": return policy -> policy.record(L, Answer.UNANSWERED);
            case "unanswered-at-29": return policy -> { policy.record(L, Answer.UNANSWERED); now += RETRY_AFTER - 1; };
            case "unanswered-expired": return policy -> { policy.record(L, Answer.UNANSWERED); now += RETRY_AFTER; };
            case "demoted": return policy -> policy.demote(L);
            case "demoted-for": return policy -> policy.demote(L, DEMOTE_FOR);
            case "demoted-for-expired": return policy -> { policy.demote(L, DEMOTE_FOR); now += DEMOTE_FOR; };
            case "demoted-all": return RecognizerAvailability::demoteAll;
            default: throw new AssertionError(name);
        }
    }

    static String letter(Known known) {
        return known == Known.UNKNOWN ? "-" : known.name().substring(0, 1);
    }

    static Answer answer(char letter) {
        return letter == 'I' ? Answer.INSTALLED : letter == 'A' ? Answer.ABSENT : Answer.UNANSWERED;
    }

    /** Builds the state, runs one event and reports the cell. */
    static String cell(String state, String column) {
        now = 1_000;
        RecognizerAvailability policy = new RecognizerAvailability(() -> now, ABSENT_FOR, RETRY_AFTER);
        state(state).accept(policy);
        int[] probes = {0};
        boolean result = false;
        String[] event = column.split(":");
        switch (event[0]) {
            case "probe": result = policy.available(L, ticket -> { probes[0]++; return answer(event[1].charAt(0)); }); break;
            case "late": policy.record(L, answer(event[1].charAt(0))); break;
            case "demote": policy.demote(L); break;
            case "demote300": policy.demote(L, DEMOTE_FOR); break;
            case "demoteAll": policy.demoteAll(); break;
            case "far": now += FAR; break;
            default: throw new AssertionError(column);
        }
        Known known = policy.known(L);
        if (event[0].equals("probe") && result != (known == Known.INSTALLED)) throw new AssertionError(state + " " + column + ": available=" + result);
        if (probes[0] > 1) throw new AssertionError(state + " " + column + ": probed twice");
        return letter(known) + (probes[0] == 1 ? "*" : "");
    }

    static void check(boolean value, String what) {
        if (!value) throw new AssertionError(what);
    }

    public static void main(String[] args) {
        int cells = 0;
        for (String row : TABLE) {
            String[] fields = row.trim().split("\\s+");
            check(fields.length == COLUMNS.length + 1, "row width: " + row);
            for (int c = 0; c < COLUMNS.length; c++) {
                String got = cell(fields[0], COLUMNS[c]);
                check(got.equals(fields[c + 1]), fields[0] + " then " + COLUMNS[c] + ": expected " + fields[c + 1] + ", got " + got);
                cells++;
            }
        }

        // Sequences the table cannot show.
        now = 0;
        RecognizerAvailability policy = new RecognizerAvailability(() -> now, ABSENT_FOR, RETRY_AFTER);
        // A demote made while a probe runs is not undone by the probe's answer.
        check(!policy.available(L, ticket -> { policy.demote(L); return Answer.INSTALLED; }), "demote during probe");
        check(policy.known(L) == Known.DEMOTED, "demote during probe kept");
        // A permanent demote outlasts a shorter one made after it, and a timed one made before it.
        policy.demote(L, DEMOTE_FOR);
        now += FAR;
        check(policy.known(L) == Known.DEMOTED, "permanent demote kept");
        policy.demote("en-US", DEMOTE_FOR);
        policy.demote("en-US");
        now += FAR;
        check(policy.known("en-US") == Known.DEMOTED, "timed then permanent demote");
        // Languages are independent.
        check(policy.known("fr-FR") == Known.UNKNOWN, "other language untouched");
        check(policy.available("fr-FR", ticket -> Answer.INSTALLED), "other language probes");
        // A service that never answers is asked once per retry window, never on every turn.
        int[] probes = {0};
        for (int turn = 0; turn < 10; turn++) {
            check(!policy.available("pt-BR", ticket -> { probes[0]++; return Answer.UNANSWERED; }), "unanswered reads false");
            now += RETRY_AFTER / 2;
        }
        check(probes[0] == 5, "one probe per retry window, got " + probes[0]);
        // The service recovers: the next probe after the window is believed.
        now += RETRY_AFTER;
        check(policy.available("pt-BR", ticket -> Answer.INSTALLED), "recovered");
        // A late answer from an older probe never overwrites a newer probe's answer: probe 1 gives
        // up, probe 2 answers after the retry window, then probe 1's answer arrives.
        for (Answer newer : new Answer[] {Answer.INSTALLED, Answer.ABSENT}) {
            String language = newer == Answer.INSTALLED ? "ja-JP" : "ko-KR";
            Answer stale = newer == Answer.INSTALLED ? Answer.ABSENT : Answer.INSTALLED;
            long[] first = {0};
            check(!policy.available(language, ticket -> { first[0] = ticket; return Answer.UNANSWERED; }), "probe 1 gives up");
            now += RETRY_AFTER;
            check(policy.available(language, ticket -> newer) == (newer == Answer.INSTALLED), "probe 2 answers");
            policy.record(language, stale, first[0]);
            check(policy.known(language) == (newer == Answer.INSTALLED ? Known.INSTALLED : Known.ABSENT),
                    "a stale late " + stale + " kept the newer " + newer);
        }
        // A late answer from the newest probe is still kept over its own unanswered entry.
        long[] last = {0};
        check(!policy.available("zh-CN", ticket -> { last[0] = ticket; return Answer.UNANSWERED; }), "unanswered");
        policy.record("zh-CN", Answer.INSTALLED, last[0]);
        check(policy.known("zh-CN") == Known.INSTALLED, "the newest probe's late answer is kept");
        System.out.println("PASS recognizer availability (" + cells + " cells)");
    }
}
