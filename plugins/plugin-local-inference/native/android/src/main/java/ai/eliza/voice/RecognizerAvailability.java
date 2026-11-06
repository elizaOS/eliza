package ai.eliza.voice;

import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * What {@link OnDeviceRecognizer} knows about each language: whether Android's on-device
 * recognizer has its model. No Android types, so the policy runs on the JVM.
 *
 * <p>An answer from the recognition service is kept: installed until a demote, absent for
 * {@code absentForMillis}, so a model installed later is seen. A probe the service did not answer
 * (an error, a timeout, an interrupt) is not an answer: the language reads as unavailable, the
 * next probe waits {@code retryAfterMillis}, and an answer that arrives after the probe gave up
 * is kept. A non-answer never replaces an answer. A demote turns a language off for good or for a
 * time, and no answer ends it early.
 */
final class RecognizerAvailability {
    /** What one probe of the recognition service learned. */
    enum Answer { INSTALLED, ABSENT, UNANSWERED }

    /** What is known about a language now. */
    enum Known { UNKNOWN, INSTALLED, ABSENT, UNANSWERED, DEMOTED }

    /** Asks the recognition service; may take seconds. */
    interface Probe {
        Answer probe();
    }

    private static final class Entry {
        final Known known;
        final long until;

        Entry(Known known, long until) {
            this.known = known;
            this.until = until;
        }
    }

    private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();
    private final LongSupplier clock;
    private final long absentForMillis;
    private final long retryAfterMillis;
    private volatile boolean demotedAll;

    RecognizerAvailability(LongSupplier clock, long absentForMillis, long retryAfterMillis) {
        this.clock = clock;
        this.absentForMillis = absentForMillis;
        this.retryAfterMillis = retryAfterMillis;
    }

    /** True when the language's model is installed; probes only when nothing current is known. */
    boolean available(String language, Probe probe) {
        Known known = known(language);
        if (known == Known.UNKNOWN) known = record(language, probe.probe());
        return known == Known.INSTALLED;
    }

    /** Records a probe's answer, including one that arrives late; returns what is known after it. */
    Known record(String language, Answer answer) {
        long now = clock.getAsLong();
        Entry next = answer == Answer.INSTALLED ? new Entry(Known.INSTALLED, Long.MAX_VALUE)
                : answer == Answer.ABSENT ? new Entry(Known.ABSENT, after(now, absentForMillis))
                : new Entry(Known.UNANSWERED, after(now, retryAfterMillis));
        Entry kept = entries.compute(language, (key, current) -> {
            boolean live = current != null && now < current.until;
            if (live && current.known == Known.DEMOTED) return current;
            if (live && answer == Answer.UNANSWERED && current.known != Known.UNANSWERED) return current;
            return next;
        });
        return demotedAll ? Known.DEMOTED : kept.known;
    }

    /** Turns the language off for good. */
    void demote(String language) {
        demote(language, Long.MAX_VALUE);
    }

    /** Turns the language off for {@code forMillis}; a longer demote already in force is kept. */
    void demote(String language, long forMillis) {
        long until = after(clock.getAsLong(), forMillis);
        entries.compute(language, (key, current) -> current != null && current.known == Known.DEMOTED
                && current.until >= until ? current : new Entry(Known.DEMOTED, until));
    }

    /** Turns every language off for good. */
    void demoteAll() {
        demotedAll = true;
    }

    private static long after(long now, long millis) {
        return millis >= Long.MAX_VALUE - now ? Long.MAX_VALUE : now + millis;
    }

    /** What is known about the language now; an expired entry is {@link Known#UNKNOWN}. */
    Known known(String language) {
        if (demotedAll) return Known.DEMOTED;
        Entry entry = entries.get(language);
        return entry == null || clock.getAsLong() >= entry.until ? Known.UNKNOWN : entry.known;
    }
}
