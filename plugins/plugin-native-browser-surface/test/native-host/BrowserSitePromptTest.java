import ai.eliza.plugins.browsersurface.BrowserExternalPage;
import ai.eliza.plugins.browsersurface.BrowserSitePrompt;
import ai.eliza.plugins.browsersurface.BrowserSitePrompt.Plan;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Plain-JVM checks for BrowserSitePrompt and BrowserExternalPage. */
public final class BrowserSitePromptTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition) throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    check(expected == null ? actual == null : expected.equals(actual),
        message + ": expected " + expected + " got " + actual);
  }

  public static void main(String[] args) {
    // Who may be asked.
    equal(BrowserSitePrompt.origin("https://a.example/x", "https://a.example/y#z", "https://a.example", false),
        "https://a.example", "the top-level page asks for its own origin");
    equal(BrowserSitePrompt.origin("https://a.example/", "https://a.example/", "https://frame.example", false),
        null, "an embedded frame's origin is refused");
    equal(BrowserSitePrompt.origin("https://a.example/", "https://b.example/", "https://a.example", false),
        null, "a page that moved to another origin is refused");
    equal(BrowserSitePrompt.origin("http://a.example/", "http://a.example/", "http://a.example", true),
        null, "cleartext pages are never asked");
    equal(BrowserSitePrompt.origin("http://127.0.0.1:8080/", "http://127.0.0.1:8080/", "http://127.0.0.1:8080", false),
        null, "local test hosts need a developer build");
    equal(BrowserSitePrompt.origin("http://127.0.0.1:8080/", "http://127.0.0.1:8080/", "http://127.0.0.1:8080", true),
        "http://127.0.0.1:8080", "developer builds may ask a local test host");
    equal(BrowserSitePrompt.origin("http://localhost.evil.example/", "http://localhost.evil.example/", "http://localhost.evil.example", true),
        null, "a lookalike host is not a local test host");
    equal(BrowserSitePrompt.origin(null, "https://a.example/", "https://a.example", false), null,
        "an uncommitted page is not asked");

    // What is asked.
    Map<String, Boolean> store = new HashMap<>();
    store.put("https://a.example camera", true);
    store.put("https://a.example microphone", false);
    int[] reads = {0};
    Plan normal = BrowserSitePrompt.plan("https://a.example", List.of("camera", "microphone", "location"), true,
        false, kind -> true, (origin, kind) -> { reads[0]++; return store.get(origin + " " + kind); });
    equal(normal.allowed, Set.of("camera"), "a stored Allow answers without asking");
    equal(List.copyOf(normal.asked), List.of("location"), "an undecided kind is asked; a stored Deny is not");
    equal(normal.granted(true), Set.of("camera", "location"), "Allow adds the asked kinds");
    equal(normal.granted(false), Set.of("camera"), "Don't allow keeps only stored Allows");
    reads[0] = 0;
    Plan priv = BrowserSitePrompt.plan("https://a.example", List.of("camera", "microphone"), true, true,
        kind -> true, (origin, kind) -> { reads[0]++; return true; });
    equal(reads[0], 0, "a private tab never reads a stored decision");
    check(priv.allowed.isEmpty() && priv.asked.equals(Set.of("camera", "microphone")), "a private tab is always asked");
    Plan hidden = BrowserSitePrompt.plan("https://a.example", List.of("camera"), false, false, kind -> true,
        (origin, kind) -> true);
    check(hidden.asked.isEmpty() && hidden.granted(true).isEmpty(), "a background tab gets nothing, even with a stored Allow");
    Plan undeclared = BrowserSitePrompt.plan("https://a.example", List.of("camera", "location"), true, false,
        kind -> !kind.equals("location"), (origin, kind) -> null);
    equal(undeclared.unavailable, List.of("location"), "a kind the app cannot hold is reported");
    equal(List.copyOf(undeclared.asked), List.of("camera"), "and is never asked");
    Plan damaged = BrowserSitePrompt.plan("https://a.example", List.of("camera", "usb"), true, false, kind -> true,
        (origin, kind) -> { throw new IllegalStateException(); });
    equal(List.copyOf(damaged.asked), List.of("camera"), "an unreadable record asks again; unknown kinds are ignored");

    // What the prompt says.
    equal(BrowserSitePrompt.labels(List.of("camera")), "camera", "one label");
    equal(BrowserSitePrompt.labels(List.of("camera", "microphone")), "camera and microphone", "two labels");
    equal(BrowserSitePrompt.labels(List.of("camera", "microphone", "location")), "camera, microphone and location",
        "three labels");
    equal(BrowserSitePrompt.title(List.of("location")), "Allow location?", "title");
    check(BrowserSitePrompt.message("a.example", List.of("camera"), true).endsWith("Private tab: this choice is not remembered."),
        "private prompts say nothing is remembered");
    check(BrowserSitePrompt.message("a.example", List.of("camera"), false).startsWith("a.example wants to use your camera."),
        "the prompt names the asking host");
    equal(Arrays.asList(BrowserSitePrompt.androidPermissions("location")),
        List.of("android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"),
        "location maps to fine or coarse");
    equal(BrowserSitePrompt.androidPermissions("usb").length, 0, "unknown kinds map to nothing");

    // External page handoff admission.
    String own = "https://localhost/";
    for (String page : new String[] {"https://accounts.example/signin?continue=x#step", "https://example.com:8443/"})
      check(BrowserExternalPage.allowed(page, own), "allowed " + page);
    for (String page : new String[] {"http://example.com/", "javascript:alert(1)", "file:///x", "content://x/y",
        "intent://x", "https://user:secret@example.com/", "https://localhost/", "https://LOCALHOST:443/",
        "https://example.com/\n", "https://example.com\\@other.invalid/", "https:///missing",
        "https://example.com/" + "x".repeat(4096)})
      check(!BrowserExternalPage.allowed(page, own), "refused " + page);
    check(!BrowserExternalPage.allowed("https://example.com/", null), "an unknown host page refuses");
    check(BrowserExternalPage.eligible("host", "browser", true, true, true), "a general browser is eligible");
    check(!BrowserExternalPage.eligible("host", "host", true, true, true), "the host itself is not");
    check(!BrowserExternalPage.eligible("host", null, true, true, true), "an unnamed package is not");
    check(!BrowserExternalPage.eligible("host", "browser", false, true, true), "a disabled browser is not");
    check(!BrowserExternalPage.eligible("host", "browser", true, false, true), "an unexported activity is not");
    check(!BrowserExternalPage.eligible("host", "deep-link-app", true, true, false), "a single-site handler is not");

    System.out.println(assertions + " assertions passed");
  }
}
