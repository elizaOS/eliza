import ai.eliza.plugins.browsersurface.BrowserEffectWatch;
import java.util.Arrays;
import java.util.Collections;

/** Plain-JVM checks for the WebView network watch, one per request kind. */
public final class BrowserEffectWatchTest {
  private static int assertions;
  private static final String ORIGIN = "https://bank.example";
  private static final long[] NONE = new long[0];

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  /** The verdict on one request the page started after a task effect. */
  private static String after(String url, String method, long delay) {
    BrowserEffectWatch watch = new BrowserEffectWatch();
    long now = System.currentTimeMillis();
    watch.arm(ORIGIN, "1", now, now + 60000);
    watch.observe(url, method, now + delay);
    return watch.read("1", NONE, null, Collections.emptyList());
  }

  public static void main(String[] args) {
    // shouldInterceptRequest reports every frame's requests, so the frame is not an input.
    check("request".equals(after("https://pay.other.example/charge", "POST", 10)), "cross-site POST from any frame");
    check("request".equals(after(ORIGIN + "/api/pay", "POST", 10)), "same-site POST before its response");
    check("request".equals(after("https://track.other.example/p.gif?amount=84", "GET", 10)), "cross-site image");
    check("request".equals(after(ORIGIN + "/api/pay", "put", 45000)), "a request after the old 30 s window");
    check(after(ORIGIN + "/api/balance", "GET", 10) == null, "own-site GET");
    check(after("https://api.bank.example/rates", "HEAD", 10) == null, "sibling host of the page's site");
    check(after("https://pay.other.example/charge", "POST", 61000) == null, "after the binding expires");

    long now = System.currentTimeMillis();
    BrowserEffectWatch watch = new BrowserEffectWatch();
    watch.arm(ORIGIN, "1", now, now + 60000);
    watch.observe(ORIGIN + "/early", "POST", now - 1);
    watch.observe("https://pay.other.example/a", "POST", now + 1000); // 1 s after her press
    watch.observe("https://pay.other.example/b", "POST", now + 9000); // after her activated control
    watch.observe(ORIGIN + "/pay?x=1", "POST", now + 100); // the consented commit
    String verdict = watch.read("1", new long[] {now}, now + 8000, Arrays.asList(ORIGIN + "/pay"));
    check(verdict == null, "her requests and one consented commit are not violations");
    watch.observe(ORIGIN + "/pay", "POST", now + 200);
    check("request".equals(watch.read("1", NONE, null, Collections.emptyList())), "a second commit is");
    check(watch.read("2", NONE, null, Collections.emptyList()) == null, "another binding sees none of it");
    Object token = watch.arm(ORIGIN, "1", now + 300, now + 60000);
    check("request".equals(watch.read("1", NONE, null, Collections.emptyList())), "it lasts for the binding");
    watch.cancel(token);
    check("request".equals(watch.read("1", NONE, null, Collections.emptyList())), "a refused effect restores it");

    BrowserEffectWatch closed = new BrowserEffectWatch();
    closed.arm(ORIGIN, "1", now, now + 60000);
    closed.close(now + 50);
    closed.observe("https://ads.other.example/", "GET", now + 60);
    check(closed.read("1", NONE, null, Collections.emptyList()) == null, "a new document ends the watch");

    System.out.println(assertions + " assertions passed");
  }
}
