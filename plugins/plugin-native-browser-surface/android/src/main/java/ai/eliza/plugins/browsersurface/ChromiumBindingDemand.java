package ai.eliza.plugins.browsersurface;

/**
 * Who needs the Chromium binding: the host's standing {@link #pin()} (the old always-on
 * {@code start()}) and open leases (a page or a task that needs the browser now). The binding is
 * wanted while either holds. When the last holder lets go, the binding stays for the idle delay,
 * so a page that closes and the next task that opens soon after share one warm browser. Plain
 * JVM; the connection calls it on the main thread.
 */
public final class ChromiumBindingDemand {
    /** What the connection does after a change in demand. */
    public enum Step { BIND, RELEASE_LATER, NONE }

    private final long idleMillis;
    private boolean pinned;
    private int leases;

    public ChromiumBindingDemand(long idleMillis) {
        if (idleMillis < 0) throw new IllegalArgumentException("idleMillis must not be negative");
        this.idleMillis = idleMillis;
    }

    public long idleMillis() { return idleMillis; }

    public boolean wanted() { return pinned || leases > 0; }

    public Step pin() { pinned = true; return Step.BIND; }

    public Step unpin() {
        if (!pinned) return Step.NONE;
        pinned = false;
        return wanted() ? Step.NONE : Step.RELEASE_LATER;
    }

    public Step acquire() { leases++; return Step.BIND; }

    public Step release() {
        if (leases == 0) throw new IllegalStateException("no Chromium lease is open");
        leases--;
        return wanted() ? Step.NONE : Step.RELEASE_LATER;
    }

    /** The idle delay ended: unbind only when nobody took the browser again meanwhile. */
    public boolean idleExpired() { return !wanted(); }
}
