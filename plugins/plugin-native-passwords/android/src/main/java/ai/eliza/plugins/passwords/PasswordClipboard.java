package ai.eliza.plugins.passwords;

final class PasswordClipboard {
  interface Platform {
    CharSequence currentLabel();
    void clear();
  }

  record Lease(Platform platform, String label, long expiresAt) {}

  private volatile Lease current;
  private Lease retired;

  Lease current() { return current; }

  Lease copied(Platform platform, String label, long expiresAt) {
    Lease lease = new Lease(platform, label, expiresAt);
    current = lease;
    retired = null;
    return lease;
  }

  void retire(Lease lease, long now) {
    if (lease == null || current != lease) return;
    retired = lease;
    clearIfDue(lease, now);
  }

  void clearIfDue(Lease lease, long now) {
    if (lease == null || current != lease || (retired != lease && now < lease.expiresAt())) return;
    try {
      CharSequence label = lease.platform().currentLabel();
      if (label == null) return;
      if (lease.label().contentEquals(label)) lease.platform().clear();
    } catch (RuntimeException unavailable) { return; }
    current = null;
    retired = null;
  }
}
