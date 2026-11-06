import ai.eliza.plugins.browsersurface.BrowserEffectWatch;
import java.util.Arrays;

/** Plain-JVM checks for the WebView network watch, one per request kind. */
public final class BrowserEffectWatchTest {
  private static int assertions;
  private static final String ORIGIN = "https://bank.example";
  private static final BrowserEffectWatch.Handoff NONE = BrowserEffectWatch.Handoff.NONE;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  /** The verdict on one request the page started after a task effect. */
  private static String after(String url, String method, long delay) {
    return after("click", url, method, false, delay);
  }

  private static String after(String subaction, String url, String method, boolean mainFrame, long delay) {
    BrowserEffectWatch watch = new BrowserEffectWatch();
    long now = System.currentTimeMillis();
    watch.arm(ORIGIN, "1", subaction, now, now + 60000, false, null, null);
    watch.observe(url, method, mainFrame, now + delay);
    return watch.read("1", NONE);
  }

  private static BrowserEffectWatch.Handoff handoff(long[] presses, Long activatedAt, String... consented) {
    return new BrowserEffectWatch.Handoff(presses, activatedAt, Arrays.asList(consented), null, null, false);
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

    // A link the click follows, to another site, also through a redirect: the page's own
    // watch and the navigation gate govern top-level navigation. A main-frame POST is not one.
    check(after("click", "https://other.example/child", "GET", true, 10) == null, "cross-site link follow");
    check("request".equals(after("click", ORIGIN + "/done", "POST", true, 10)), "ungranted main-frame POST");
    // After a fill, select or scroll only a write counts, not a cross-site read.
    for (String subaction : new String[] {"fill", "select", "scroll"}) {
      check(after(subaction, "https://cdn.other.example/a.png", "GET", false, 10) == null,
          subaction + ": cross-site GET");
      check("request".equals(after(subaction, "https://pay.other.example/charge", "POST", false, 10)),
          subaction + ": POST");
    }

    long now = System.currentTimeMillis();
    BrowserEffectWatch watch = new BrowserEffectWatch();
    watch.arm(ORIGIN, "1", "click", now, now + 60000, false, null, null);
    watch.observe(ORIGIN + "/early", "POST", false, now - 1);
    watch.observe("https://pay.other.example/a", "POST", false, now + 1000); // 1 s after her press
    watch.observe("https://pay.other.example/b", "POST", false, now + 9000); // after her activated control
    check(watch.read("1", handoff(new long[] {now}, now + 8000)) == null, "her requests are not violations");
    watch.observe(ORIGIN + "/pay", "POST", false, now + 2000); // between her press and her control
    check("request".equals(watch.read("1", handoff(new long[0], null, ORIGIN + "/pay"))),
        "a consented URL the page reports excuses nothing without a grant");
    check(watch.read("2", NONE) == null, "another binding sees none of it");
    Object token = watch.arm(ORIGIN, "1", "click", now + 300, now + 60000, false, null, null);
    check("request".equals(watch.read("1", NONE)), "it lasts for the binding");
    watch.cancel(token);
    check("request".equals(watch.read("1", NONE)), "a refused effect restores it");

    // A granted form POST that loads a page: the click result names the commit, and the new
    // document's snapshot, which has no handoff, finds no violation.
    BrowserEffectWatch form = new BrowserEffectWatch();
    form.arm(ORIGIN, "1", "click", now, now + 60000, true, null, null);
    form.observe(ORIGIN + "/done", "POST", true, now + 10);
    form.report("1", new BrowserEffectWatch.Handoff(new long[0], null, Arrays.asList(ORIGIN + "/done"),
        ORIGIN + "/done", "POST", true));
    form.close(now + 20);
    check(form.read("1", NONE) == null, "a granted page-load commit");
    form.arm(ORIGIN, "1", "click", now + 30, now + 60000, true, null, null);
    form.observe(ORIGIN + "/done", "POST", true, now + 40);
    check("request".equals(form.read("1", NONE)), "a second page-load commit with nothing named");

    // A granted fetch is excused at its start by the grant's request target, before the
    // page sees it complete; a second one is not.
    BrowserEffectWatch fetch = new BrowserEffectWatch();
    fetch.arm(ORIGIN, "1", "click", now, now + 60000, true, "/api/slow", "POST");
    fetch.observe(ORIGIN + "/api/slow", "POST", false, now + 10);
    check(fetch.read("1", NONE) == null, "a granted fetch in flight");
    fetch.observe(ORIGIN + "/api/slow", "POST", false, now + 20);
    check("request".equals(fetch.read("1", NONE)), "the grant is spent once");
    BrowserEffectWatch method = new BrowserEffectWatch();
    method.arm(ORIGIN, "1", "click", now, now + 60000, true, "/api/slow", "POST");
    method.observe(ORIGIN + "/api/slow", "DELETE", false, now + 10);
    check("request".equals(method.read("1", NONE)), "another method is not the granted request");

    BrowserEffectWatch closed = new BrowserEffectWatch();
    closed.arm(ORIGIN, "1", "click", now, now + 60000, false, null, null);
    closed.close(now + 50);
    closed.observe("https://ads.other.example/", "GET", false, now + 60);
    check(closed.read("1", NONE) == null, "a new document ends the watch");

    System.out.println(assertions + " assertions passed");
  }
}
