import ai.eliza.plugins.browsersurface.BrowserCapturePolicy;
import ai.eliza.plugins.browsersurface.BrowserProfilePolicy;
import java.util.Arrays;

/** Plain-JVM checks for BrowserProfilePolicy and BrowserCapturePolicy. */
public final class BrowserProfileCaptureTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  public static void main(String[] args) {
    long day = 24L * 60 * 60 * 1000;
    // Keys are bounded and printable; the profile name is a digest, never the key.
    check(BrowserProfilePolicy.validKey("acct_123:grace@example.com"), "account key");
    check(!BrowserProfilePolicy.validKey(""), "empty key");
    check(!BrowserProfilePolicy.validKey("a\u0000b"), "control characters");
    check(!BrowserProfilePolicy.validKey("x".repeat(129)), "long key");
    check(!BrowserProfilePolicy.validKey(null), "missing key");
    // Prefixes never overlap: the start-up purge of leftovers must not touch kept sign-ins.
    check(BrowserProfilePolicy.ephemeral("eliza-browser-abc"), "ephemeral name");
    check(!BrowserProfilePolicy.ephemeral(BrowserProfilePolicy.KEYED_PREFIX + "abc"),
        "keyed profiles survive the start-up purge");
    check(BrowserProfilePolicy.keyed(BrowserProfilePolicy.KEYED_PREFIX + "abc"), "keyed name");
    check(!BrowserProfilePolicy.keyed("Default"), "the default profile is never keyed");
    // Idle expiry (30 days in the product).
    long now = 100 * day;
    check(!BrowserProfilePolicy.expired(now - 29 * day, now, 30 * day), "used recently");
    check(BrowserProfilePolicy.expired(now - 30 * day, now, 30 * day), "idle for 30 days");
    check(BrowserProfilePolicy.expired(null, now, 30 * day), "undated profiles expire");
    check(!BrowserProfilePolicy.validIdle(1000), "an idle expiry of seconds is refused");
    check(BrowserProfilePolicy.validIdle(30 * day), "30 days");
    check(BrowserProfilePolicy.DELETE_RETRY_MS[0] == 0, "deletion is tried at once");
    // Capture size.
    check(Arrays.equals(BrowserCapturePolicy.scaled(2560, 1600, 1024), new int[] {1024, 640}),
        "landscape tablet fits 1024");
    check(Arrays.equals(BrowserCapturePolicy.scaled(1200, 1920, 1024), new int[] {640, 1024}),
        "portrait tablet fits 1024");
    check(Arrays.equals(BrowserCapturePolicy.scaled(800, 600, 1024), new int[] {800, 600}),
        "never scaled up");
    check(Arrays.equals(BrowserCapturePolicy.scaled(5000, 1, 1024), new int[] {1024, 1}),
        "at least one pixel");
    check(BrowserCapturePolicy.validMaxEdge(1024) && !BrowserCapturePolicy.validMaxEdge(4096)
            && !BrowserCapturePolicy.validMaxEdge(100), "edge bounds");
    check(BrowserCapturePolicy.validQuality(70) && !BrowserCapturePolicy.validQuality(100),
        "quality bounds");
    System.out.println(assertions + " assertions passed");
  }
}
