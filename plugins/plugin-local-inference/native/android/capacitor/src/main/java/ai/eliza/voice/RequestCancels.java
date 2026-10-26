package ai.eliza.voice;

import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The plugin's cancellable requests, by caller request id. A request is queued
 * when its call arrives, holds its stop while it runs, and is forgotten when it
 * ends. Only known requests are marked cancelled, so a cancel for a finished or
 * unknown id leaves nothing behind. Capacitor delivers one plugin's calls in
 * order, so a cancel always follows its request's {@link #queue}.
 *
 * <p>No Android types, so the rule runs on the JVM.
 */
final class RequestCancels {
    private static final Runnable QUEUED = () -> {};
    private final Map<String, Runnable> stops = new ConcurrentHashMap<>();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();

    /** The call arrived; it waits for its worker. */
    void queue(String id) {
        stops.put(id, QUEUED);
    }

    /**
     * The request now runs with {@code stop}. Throws when it was cancelled
     * while queued. {@link #cancel} marks first and then stops, so either
     * order is seen.
     */
    void running(String id, Runnable stop) {
        stops.put(id, stop);
        if (cancelled.containsKey(id)) throw new CancellationException();
    }

    /** The request ended; nothing about it is kept. */
    void finish(String id) {
        stops.remove(id);
        cancelled.remove(id);
    }

    /** Marks and stops a known request. False when no such request is pending. */
    boolean cancel(String id) {
        Runnable stop = stops.computeIfPresent(id, (key, current) -> {
            cancelled.put(key, Boolean.TRUE);
            return current;
        });
        if (stop == null) return false;
        stop.run();
        return true;
    }

    /** Marks and stops every pending request. */
    void cancelAll() {
        for (String id : stops.keySet()) cancelled.put(id, Boolean.TRUE);
        for (Runnable stop : stops.values()) stop.run();
    }

    int pending() {
        return stops.size();
    }

    int marks() {
        return cancelled.size();
    }
}
