package ai.eliza.plugins.browsersurface;

/**
 * Which WebView storage profiles a browser surface keeps, and for how long.
 *
 * <p>An isolated surface without a key gets a fresh profile that is deleted as soon as Android
 * releases it after the surface closes (Android keeps a profile in use for a moment after its
 * WebView is destroyed, so deletion is retried, and any profile still left is deleted at the next
 * process start). Its cookies and storage are cleared at once either way.
 *
 * <p>An isolated surface with a {@code profileKey} (for example a signed-in account id) shares one
 * persistent profile with every surface of the same owner and key, so website sign-ins survive
 * across openings. Its name is a digest, never the key. The host purges it at once (account sign
 * out, "Sign out of websites") or after it has been idle for the host's expiry. Pure JVM.
 */
public final class BrowserProfilePolicy {
  /** Ephemeral profiles; every one left over is deleted at process start. */
  public static final String EPHEMERAL_PREFIX = "eliza-browser-";
  /** Keyed profiles; kept across process starts until purged. */
  public static final String KEYED_PREFIX = "eliza-keyed-browser-";
  /** Shortest idle expiry a host may ask for; a shorter one would purge profiles in use. */
  public static final long MIN_IDLE_MS = 60L * 60 * 1000;
  /** Delays between attempts to delete a profile Android has not released yet. */
  public static final long[] DELETE_RETRY_MS = {0, 250, 1000, 4000};

  private BrowserProfilePolicy() {}

  /** A key is short, printable and carries no separators that could collide in the digest. */
  public static boolean validKey(String key) {
    return key != null && key.matches("[A-Za-z0-9._:@-]{1,128}");
  }

  public static boolean ephemeral(String name) {
    return name != null && name.startsWith(EPHEMERAL_PREFIX);
  }

  public static boolean keyed(String name) {
    return name != null && name.startsWith(KEYED_PREFIX);
  }

  /**
   * Whether a keyed profile is past its idle expiry. A profile with no recorded use is expired:
   * keeping sign-ins nobody can date would outlive the promise the host made.
   */
  public static boolean expired(Long lastUsedMs, long nowMs, long idleMs) {
    return lastUsedMs == null || nowMs - lastUsedMs >= idleMs;
  }

  public static boolean validIdle(long idleMs) {
    return idleMs >= MIN_IDLE_MS;
  }
}
