package ai.eliza.plugins.actionjournal.deletion;

/**
 * Persisted monotonic Undo deadline. Expiry is measured on one uninterrupted monotonic clock
 * ({@code continuity}, for example a boot count); wall time is display metadata only. A reboot or
 * an unknown clock reads as {@link State#CLOCK_CHANGED} and requires renewed review.
 * Matches {@code DELETE_UNDO_MS} in {@code @elizaos/contracts/deletion-window}.
 */
public final class DeletionDeadline {
 public static final long WINDOW_MS = 10000;
 public final String continuity;
 public final long createdElapsed, expiresElapsed, expiresAt;

 public DeletionDeadline(String continuity, long elapsed, long wall) {
  if (continuity == null || continuity.isEmpty() || continuity.length() > 200 || elapsed < 0 || elapsed > Long.MAX_VALUE - WINDOW_MS || wall < 0 || wall > Long.MAX_VALUE - WINDOW_MS)
   throw new IllegalArgumentException("Deletion clock unavailable");
  this.continuity = continuity;
  createdElapsed = elapsed;
  expiresElapsed = elapsed + WINDOW_MS;
  expiresAt = wall + WINDOW_MS;
 }

 public enum State { OPEN, EXPIRED, CLOCK_CHANGED }

 public State state(String boot, long elapsed) {
  if (!continuity.equals(boot) || elapsed < createdElapsed) return State.CLOCK_CHANGED;
  return elapsed < expiresElapsed ? State.OPEN : State.EXPIRED;
 }
}
