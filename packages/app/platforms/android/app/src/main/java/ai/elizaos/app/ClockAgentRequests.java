package ai.elizaos.app;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.LongSupplier;

/** Process-local cancellation only; no authorization, retry, network, scheduler or durable effect store.
 * Tickets exist before worker admission, including early-cancel tombstones. Demand cleanup retains
 * finished/cancelled identities for ten minutes; every admitted request has a five-minute deadline.
 */
final class ClockAgentRequests {
    private static final long DEADLINE_MILLIS = 300000, RETAIN_MILLIS = 600000;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final LongSupplier now;
    private final int capacity;
    ClockAgentRequests(LongSupplier now, int capacity) { this.now = Objects.requireNonNull(now); this.capacity = capacity; }
    final class Entry {
        final String id;
        final Object owner;
        final long issued;
        volatile boolean cancelled, finished;
        private Runnable disconnect;
        Entry(String id, Object owner, boolean cancelled) { this.id = id; this.owner = owner; this.cancelled = cancelled; issued = now.getAsLong(); }
        void current(Object actualOwner) {
            long instant = now.getAsLong();
            if (cancelled || finished || owner != actualOwner || instant < issued || instant - issued >= DEADLINE_MILLIS)
                throw new SecurityException("Native agent request cancelled, expired or owner changed");
        }
        synchronized void connected(Runnable close) { disconnect = close; if (cancelled || finished) close.run(); }
        synchronized void cancel() { cancelled = true; if (disconnect != null) disconnect.run(); }
        synchronized void finish() { finished = true; disconnect = null; }
    }
    synchronized Entry begin(String id, Object owner) {
        Objects.requireNonNull(owner); cleanup();
        if (entries.containsKey(id)) throw new SecurityException("Native request identity cancelled or already used");
        if (entries.size() >= capacity) throw new IllegalStateException("Native request admission budget exhausted");
        Entry entry = new Entry(id, owner, false); entries.put(id, entry); return entry;
    }
    synchronized void cancel(String id) {
        cleanup(); Entry entry = entries.get(id);
        if (entry == null) {
            if (entries.size() >= capacity) throw new IllegalStateException("Native cancellation budget exhausted");
            entry = new Entry(id, null, true); entry.finished = true; entries.put(id, entry);
        } else entry.cancel();
    }
    synchronized void cancelOwner(Object owner) {
        for (Entry entry : entries.values()) if (entry.owner == owner) entry.cancel();
    }
    private void cleanup() {
        long instant = now.getAsLong();
        entries.values().removeIf(entry -> (entry.finished || entry.owner == null) && instant >= entry.issued && instant - entry.issued >= RETAIN_MILLIS);
    }
}
