import ai.eliza.plugins.browsersurface.BrowserDocumentCommit;

/** Plain-JVM checks for BrowserDocumentCommit: which callbacks describe the shown document. */
public final class BrowserDocumentCommitTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    check(expected == null ? actual == null : expected.equals(actual),
        message + ": expected " + expected + " got " + actual);
  }

  public static void main(String[] args) {
    String page = "https://shop.example/list";
    // Same-document moves: pushState, #fragment, Back/Forward between such entries.
    check(BrowserDocumentCommit.sameDocument("https://shop.example/item/2", "https://shop.example/item/2",
        false, false, false, "", page), "pushState at the committed origin");
    check(BrowserDocumentCommit.sameDocument(page + "#reviews", page + "#reviews", false, false, false, "", page),
        "fragment");
    check(!BrowserDocumentCommit.sameDocument(page, page, true, false, false, "", page), "a reload is a new document");
    check(!BrowserDocumentCommit.sameDocument("https://shop.example/next", "https://shop.example/next",
        false, true, false, "", page), "a started cross-document load waits for its own commit");
    check(!BrowserDocumentCommit.sameDocument(page + "#a", page + "#a", false, false, true, "", page), "dead tab");
    check(!BrowserDocumentCommit.sameDocument(page + "#a", page + "#a", false, false, false, "Page could not load.", page),
        "failed tab");
    check(!BrowserDocumentCommit.sameDocument("https://shop.example/a", "https://shop.example/b",
        false, false, false, "", page), "the engine shows another address");
    check(!BrowserDocumentCommit.sameDocument("https://evil.example/", "https://evil.example/",
        false, false, false, "", page), "another origin is never a same-document commit");
    check(!BrowserDocumentCommit.sameDocument("http://shop.example/list", "http://shop.example/list",
        false, false, false, "", page), "a scheme change is another origin");
    check(!BrowserDocumentCommit.sameDocument(page, page, false, false, false, "", ""), "nothing committed yet");

    // Commit callbacks: exact address, or a same-origin rewrite of the started load.
    String started = "https://news.example/story?utm=feed";
    equal(BrowserDocumentCommit.committedUrl(started, started, started, started), started, "exact address");
    equal(BrowserDocumentCommit.committedUrl(started, "https://news.example/story", started, started),
        "https://news.example/story", "replaceState before first paint adopts the engine address");
    equal(BrowserDocumentCommit.committedUrl(started, "https://news.example/story", started, null),
        "https://news.example/story", "no main-frame request seen");
    equal(BrowserDocumentCommit.committedUrl(started, "https://other.example/story", started, started), null,
        "a cross-origin engine address is not a rewrite");
    equal(BrowserDocumentCommit.committedUrl(started, "https://news.example/next", started, "https://news.example/next"),
        null, "a superseded load's late commit does not commit the next one");
    equal(BrowserDocumentCommit.committedUrl("https://news.example/old", "https://news.example/story", started, null),
        null, "a callback for a load this tab did not start");
    equal(BrowserDocumentCommit.committedUrl(started, null, started, started), null, "no engine address");

    // TLS errors: only the main document fails the tab.
    check(BrowserDocumentCommit.mainResource("https://expired.example/", "https://expired.example/", "https://expired.example/", false),
        "the pending main-frame request");
    check(BrowserDocumentCommit.mainResource("https://expired.example/", null, "https://expired.example/", false),
        "the tab's address before any commit");
    check(!BrowserDocumentCommit.mainResource("https://expired.example/img.png", page, page, true),
        "an image inside a valid page");
    check(!BrowserDocumentCommit.mainResource(page, "https://shop.example/next", page, true),
        "the committed address while another load is pending");
    check(!BrowserDocumentCommit.mainResource(null, page, page, false), "no address");
    System.out.println(assertions + " assertions passed");
  }
}
