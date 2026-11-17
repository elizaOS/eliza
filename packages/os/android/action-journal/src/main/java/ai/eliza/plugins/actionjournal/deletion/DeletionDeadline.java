package ai.eliza.plugins.actionjournal.deletion;

/**
 * Persisted monotonic Undo deadline. Expiry is measured on one uninterrupted monotonic clock
 * ({@code continuity}, for example a boot count); wall time is display metadata only. A reboot or
 * an unknown clock reads as {@code clock-changed} and requires renewed review.
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

 /** The one deadline comparison: open, expired or clock-changed for a persisted deadline. */
 public static String window(String continuity, long createdElapsed, long expiresElapsed, String boot, long elapsed) {
  if (!continuity.equals(boot) || elapsed < createdElapsed) return "clock-changed";
  return elapsed < expiresElapsed ? "open" : "expired";
 }
}
