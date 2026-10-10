import ai.eliza.plugins.browsersurface.BrowserSessionPolicy;
import ai.eliza.plugins.browsersurface.BrowserSessionPolicy.Snapshot;
import ai.eliza.plugins.browsersurface.BrowserSessionPolicy.Tab;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Plain-JVM checks for BrowserSessionPolicy. Synthetic addresses only. */
public final class BrowserSessionPolicyTest {
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

  private static void throwsType(Class<? extends Throwable> type, Runnable action, String message) {
    try {
      action.run();
    } catch (Throwable thrown) {
      check(type.isInstance(thrown), message + ": wrong exception " + thrown);
      return;
    }
    check(false, message + ": no exception");
  }

  public static void main(String[] args) {
    // Address rules.
    check(BrowserSessionPolicy.validUrl("https://example.test/a?b=c"), "https accepted");
    check(BrowserSessionPolicy.validUrl("http://example.test/"), "http accepted for tabs");
    check(!BrowserSessionPolicy.validUrl("https://user:pw@example.test/"), "user info refused");
    check(!BrowserSessionPolicy.validUrl("https://example.test/a b"), "space refused");
    check(!BrowserSessionPolicy.validUrl("https://example.test/\u0007"), "control refused");
    check(!BrowserSessionPolicy.validUrl("javascript:alert(1)"), "javascript refused");
    check(!BrowserSessionPolicy.validUrl("file:///sdcard/x"), "file refused");
    check(!BrowserSessionPolicy.validUrl("data:text/plain,x"), "data refused");
    check(!BrowserSessionPolicy.validUrl("https:///nohost"), "no host refused");
    check(!BrowserSessionPolicy.validUrl(null), "null refused");
    check(!BrowserSessionPolicy.validUrl("//example.test/path"),
        "scheme-relative address refused without throwing");
    check(!BrowserSessionPolicy.validBookmark("//example.test/path"),
        "scheme-relative bookmark refused without throwing");
    check(!BrowserSessionPolicy.validUrl(""), "empty refused");
    char[] longPath = new char[BrowserSessionPolicy.MAX_URL];
    Arrays.fill(longPath, 'a');
    check(!BrowserSessionPolicy.validUrl("https://example.test/" + new String(longPath)),
        "over-long refused");
    check(BrowserSessionPolicy.validBookmark("https://example.test/"), "https bookmark");
    check(!BrowserSessionPolicy.validBookmark("http://example.test/"), "http bookmark refused");
    check(BrowserSessionPolicy.validTabId("tab_1-A"), "tab id");
    check(!BrowserSessionPolicy.validTabId("tab 1"), "tab id with space refused");
    check(!BrowserSessionPolicy.validTabId(""), "empty tab id refused");
    equal(BrowserSessionPolicy.title(" a\nb\u0000c "), "a b c", "title controls become spaces");
    equal(BrowserSessionPolicy.title(null), "", "null title");
    char[] longTitle = new char[500];
    Arrays.fill(longTitle, 't');
    equal(BrowserSessionPolicy.title(new String(longTitle)).length(), 500,
        "complete title preserved");

    // Ephemeral tabs never persist.
    List<Tab> tabs = Arrays.asList(new Tab("a", "https://one.test/", "One", false),
        new Tab("p", "https://private.test/?session=secret", "Private", true),
        new Tab("a", "https://dup.test/", "Duplicate id", false),
        new Tab("b", "javascript:void(0)", "Bad", false),
        new Tab("c", "https://two.test/", "Two\t", false));
    Snapshot snapshot = BrowserSessionPolicy.persistable(
        tabs, Arrays.asList("https://one.test/", "https://one.test/", "ftp://x.test/"), "p");
    equal(snapshot.tabs.size(), 2, "only valid persistent tabs");
    equal(snapshot.tabs.get(0).id, "a", "order kept");
    equal(snapshot.tabs.get(1).title, "Two", "title cleaned");
    for (Tab tab : snapshot.tabs)
      check(!tab.ephemeral && !tab.url.contains("private.test"), "no private tab in snapshot");
    equal(snapshot.current, "", "a private current tab is not persisted");
    equal(
        snapshot.history, Arrays.asList("https://one.test/"), "history de-duplicated and filtered");
    equal(
        BrowserSessionPolicy.persistable(tabs, null, "c").current, "c", "persistent current kept");
    equal(BrowserSessionPolicy.persistable(tabs, null, "missing").current, "",
        "unknown current dropped");
    equal(BrowserSessionPolicy.persistable(null, null, null).tabs.size(), 0, "empty snapshot");
    throwsType(UnsupportedOperationException.class,
        () -> snapshot.tabs.add(new Tab("z", "https://z.test/", "", false)), "snapshot immutable");

    List<Tab> many = new ArrayList<>();
    for (int i = 0; i < 20; i++) many.add(new Tab("t" + i, "https://t" + i + ".test/", "", false));
    equal(BrowserSessionPolicy.persistable(many, null, "t19").tabs.size(), 20,
        "all restored tabs retained");
    equal(BrowserSessionPolicy.persistable(many, null, "t19").current, "t19",
        "selected restored tab retained");
    List<String> longHistory = new ArrayList<>();
    for (int i = 0; i < 150; i++) longHistory.add("https://h" + i + ".test/");
    equal(BrowserSessionPolicy.restore(null, longHistory, "").history.size(), 150,
        "all restored history retained");

    // Visits.
    List<String> history = BrowserSessionPolicy.recordVisit(null, "https://a.test/", false);
    history = BrowserSessionPolicy.recordVisit(history, "https://b.test/", false);
    history = BrowserSessionPolicy.recordVisit(history, "https://a.test/", false);
    equal(history, Arrays.asList("https://a.test/", "https://b.test/"), "newest first, once");
    equal(BrowserSessionPolicy.recordVisit(history, "https://private.test/", true), history,
        "ephemeral visit not recorded");
    equal(BrowserSessionPolicy.recordVisit(history, "chrome://settings", false), history,
        "invalid visit not recorded");
    List<String> full = new ArrayList<>(longHistory.subList(0, 100));
    equal(BrowserSessionPolicy.recordVisit(full, "https://new.test/", false).size(), 101,
        "visit preserves older history");
    equal(BrowserSessionPolicy.recordVisit(full, "https://new.test/", false).get(0),
        "https://new.test/", "visit is newest");
    equal(full.size(), 100, "input list not mutated");

    // Site clearing.
    check(
        BrowserSessionPolicy.belongsToSite("https://example.test/", "example.test"), "site itself");
    check(BrowserSessionPolicy.belongsToSite("https://mail.EXAMPLE.test/", "example.test"),
        "subdomain, case-insensitive");
    check(!BrowserSessionPolicy.belongsToSite("https://notexample.test/", "example.test"),
        "suffix that is not a subdomain");
    check(!BrowserSessionPolicy.belongsToSite("https://example.test.evil.test/", "example.test"),
        "prefix that is not the site");
    check(!BrowserSessionPolicy.belongsToSite("https://example.test/", ""),
        "empty site matches nothing");
    equal(BrowserSessionPolicy.withoutSite(Arrays.asList("https://example.test/",
                                               "https://a.example.test/x", "https://other.test/"),
              "example.test"),
        Arrays.asList("https://other.test/"), "withoutSite");

    // Bookmarks.
    List<String> bookmarks = BrowserSessionPolicy.changeBookmark(null, "https://a.test/", true);
    bookmarks = BrowserSessionPolicy.changeBookmark(bookmarks, "https://b.test/", true);
    bookmarks = BrowserSessionPolicy.changeBookmark(bookmarks, "https://a.test/", true);
    equal(bookmarks, Arrays.asList("https://a.test/", "https://b.test/"),
        "bookmark newest first, once");
    equal(BrowserSessionPolicy.changeBookmark(bookmarks, "https://a.test/", false),
        Arrays.asList("https://b.test/"), "bookmark removed");
    final List<String> fixed = bookmarks;
    throwsType(IllegalArgumentException.class,
        ()
            -> BrowserSessionPolicy.changeBookmark(fixed, "http://a.test/", true),
        "http bookmark refused");
    throwsType(IllegalStateException.class,
        ()
            -> BrowserSessionPolicy.restoreBookmarks(
                Arrays.asList("https://a.test/", "https://a.test/")),
        "duplicate record damaged");
    throwsType(IllegalStateException.class,
        ()
            -> BrowserSessionPolicy.restoreBookmarks(
                Arrays.asList("https://a.test/", "javascript:x")),
        "invalid record damaged");
    List<String> hundred = new ArrayList<>();
    for (int i = 0; i < BrowserSessionPolicy.MAX_BOOKMARKS; i++)
      hundred.add("https://b" + i + ".test/");
    equal(BrowserSessionPolicy.restoreBookmarks(hundred).size(), BrowserSessionPolicy.MAX_BOOKMARKS,
        "bound accepted");
    throwsType(IllegalStateException.class,
        ()
            -> BrowserSessionPolicy.changeBookmark(hundred, "https://new.test/", true),
        "bookmark limit");
    equal(BrowserSessionPolicy.changeBookmark(hundred, "https://b5.test/", true).get(0),
        "https://b5.test/", "re-adding at the limit moves it");
    List<String> tooMany = new ArrayList<>(hundred);
    tooMany.add("https://extra.test/");
    throwsType(IllegalStateException.class,
        () -> BrowserSessionPolicy.restoreBookmarks(tooMany), "over-long record damaged");

    System.out.println(assertions + " assertions passed");
  }
}
