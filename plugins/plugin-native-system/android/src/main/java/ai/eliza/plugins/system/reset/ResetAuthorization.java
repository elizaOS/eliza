package ai.eliza.plugins.system.reset;

/**
 * One activity-owned confirmation followed by one fresh Android device-credential result, never a
 * reusable unlock. Every token is single use; cancellation, a second review, retirement or a stale
 * token from an earlier review cannot authorize a reset.
 */
public final class ResetAuthorization {
    private long generation;
    private boolean active;
    private boolean confirmed;

    /** Opens a review. Only one review exists at a time. */
    public synchronized long begin() {
        if (active) throw new IllegalStateException("Reset review already open");
        active = true;
        confirmed = false;
        return ++generation;
    }

    /** The native disclosure was accepted for this review. */
    public synchronized boolean confirm(long token) {
        if (!active || token != generation) return false;
        confirmed = true;
        return true;
    }

    /** Consumes the review: true only for a confirmed review followed by a fresh unlock. */
    public synchronized boolean authenticate(long token, boolean accepted) {
        if (!active || token != generation) return false;
        boolean authorized = confirmed && accepted;
        active = false;
        confirmed = false;
        ++generation;
        return authorized;
    }

    public synchronized void retire() {
        active = false;
        confirmed = false;
        ++generation;
    }
}
