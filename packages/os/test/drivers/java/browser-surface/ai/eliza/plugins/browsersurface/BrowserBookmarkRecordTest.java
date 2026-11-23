package ai.eliza.plugins.browsersurface;

import ai.eliza.plugins.browsersurface.BrowserBookmarkRecord.Entry;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BrowserBookmarkRecordTest {
  private static int assertions;
  private static final Predicate<String> VALID = BrowserSessionPolicy::validBookmark;

  private interface Change {
    void run() throws Exception;
  }

  private static void check(boolean value, String message) {
    assertions++;
    if (!value) throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    assertions++;
    if (!expected.equals(actual)) throw new AssertionError(message + ": " + actual);
  }

  private static void sameRecord(String actual, String expected, String message) {
    assertions++;
    if (!new JSONArray(actual).similar(new JSONArray(expected))) throw new AssertionError(message + ": " + actual);
  }

  private static void refused(String json, String message) {
    assertions++;
    try {
      BrowserBookmarkRecord.read(json, VALID);
    } catch (Exception damaged) {
      return;
    }
    throw new AssertionError("damaged record accepted: " + message);
  }

  private static void throwsOn(Class<? extends Exception> kind, Change change, String message) throws Exception {
    assertions++;
    try {
      change.run();
    } catch (Exception thrown) {
      if (kind.isInstance(thrown)) return;
      throw new AssertionError(message + ": " + thrown);
    }
    throw new AssertionError(message);
  }

  public static void main(String[] args) throws Exception {
    String earlier = "[\"https://b.test/x?q=1\",\"https://a.test/\"]";
    List<Entry> rows = BrowserBookmarkRecord.read(earlier, VALID);
    equal(rows, List.of(new Entry("https://b.test/x?q=1", null), new Entry("https://a.test/", null)), "an earlier record reads without titles");
    sameRecord(BrowserBookmarkRecord.write(rows), earlier, "a record without titles keeps the earlier form");
    check(BrowserBookmarkRecord.read(null, VALID).isEmpty(), "no record is no bookmarks");
    check(BrowserBookmarkRecord.read("[]", VALID).isEmpty(), "an empty record is no bookmarks");

    List<Entry> plain = BrowserBookmarkRecord.change(rows, "https://a.test/", true, null, VALID);
    sameRecord(BrowserBookmarkRecord.write(plain), "[\"https://a.test/\",\"https://b.test/x?q=1\"]", "saving again moves the address first, once");
    sameRecord(BrowserBookmarkRecord.write(BrowserBookmarkRecord.change(plain, "https://a.test/", false, null, VALID)), "[\"https://b.test/x?q=1\"]", "removal");

    List<Entry> titled = BrowserBookmarkRecord.change(plain, "https://c.test/", true, "  Garden\tjournal\n", VALID);
    equal(titled.get(0), new Entry("https://c.test/", "Garden journal"), "a title loses control characters and surrounding space");
    String written = BrowserBookmarkRecord.write(titled);
    sameRecord(written, "[{\"url\":\"https://c.test/\",\"title\":\"Garden journal\"},\"https://a.test/\",\"https://b.test/x?q=1\"]", "titled rows are objects and the rest stay addresses");
    equal(BrowserBookmarkRecord.read(written, VALID), titled, "a round trip keeps order and titles");

    List<Entry> kept = BrowserBookmarkRecord.change(BrowserBookmarkRecord.change(titled, "https://a.test/", true, null, VALID), "https://c.test/", true, null, VALID);
    equal(kept.get(0), new Entry("https://c.test/", "Garden journal"), "a change that names no title keeps it");
    equal(BrowserBookmarkRecord.change(kept, "https://c.test/", true, "Notes", VALID).get(0).title, "Notes", "a new title replaces it");
    check(BrowserBookmarkRecord.change(kept, "https://c.test/", true, " \u0007 ", VALID).get(0).title == null, "a blank title removes it");
    List<Entry> removed = BrowserBookmarkRecord.change(kept, "https://c.test/", false, "ignored", VALID);
    check(removed.stream().noneMatch(entry -> entry.url.equals("https://c.test/")), "removal ignores the title");
    check(BrowserBookmarkRecord.change(removed, "https://c.test/", true, null, VALID).get(0).title == null, "a removed bookmark forgets its title");

    String bounded = BrowserBookmarkRecord.title("a".repeat(BrowserBookmarkRecord.MAX_TITLE - 1) + "😀tail");
    equal(bounded.length(), BrowserBookmarkRecord.MAX_TITLE - 1, "a surrogate pair at the bound is dropped whole");
    check(!Character.isHighSurrogate(bounded.charAt(bounded.length() - 1)), "no lone surrogate");
    equal(BrowserBookmarkRecord.title("z".repeat(10000)).length(), BrowserBookmarkRecord.MAX_TITLE, "a title keeps at most 300 units");
    check(BrowserBookmarkRecord.title(null) == null && BrowserBookmarkRecord.title("   ") == null, "null and blank are no title");

    refused("not json", "not json");
    refused("{}", "not a list");
    refused("[\"http://a.test/\"]", "an http address");
    refused("[\"https://a.test/\",\"https://a.test/\"]", "a repeated address");
    refused("[\"https://a.test/\",{\"url\":\"https://a.test/\",\"title\":\"A\"}]", "a repeated address with a title");
    refused("[null]", "a null row");
    refused("[7]", "a number row");
    refused("[{\"title\":\"A\"}]", "a titled row without an address");
    refused("[{\"url\":\"https://a.test/\"}]", "an object row without a title");
    refused("[{\"url\":\"https://a.test/\",\"title\":\"\"}]", "an empty stored title");
    refused("[{\"url\":\"https://a.test/\",\"title\":\" A\"}]", "an untrimmed stored title");
    refused("[{\"url\":\"https://a.test/\",\"title\":\"A\\u0000B\"}]", "a control character in a stored title");
    refused("[{\"url\":\"https://a.test/\",\"title\":7}]", "a stored title that is not text");
    refused("[{\"url\":\"https://a.test/\",\"title\":\"" + "t".repeat(BrowserBookmarkRecord.MAX_TITLE + 1) + "\"}]", "an over-long stored title");

    JSONArray hundred = new JSONArray();
    for (int i = 0; i < BrowserBookmarkRecord.MAX; i++)
      hundred.put(i % 2 == 0 ? "https://b" + i + ".test/" : new JSONObject().put("url", "https://b" + i + ".test/").put("title", "B " + i));
    List<Entry> full = BrowserBookmarkRecord.read(hundred.toString(), VALID);
    equal(full.size(), BrowserBookmarkRecord.MAX, "a full record reads");
    throwsOn(IllegalStateException.class, () -> BrowserBookmarkRecord.change(full, "https://new.test/", true, "New", VALID), "a new bookmark at 100 is refused");
    equal(BrowserBookmarkRecord.change(full, "https://b5.test/", true, null, VALID).get(0), new Entry("https://b5.test/", "B 5"), "moving a bookmark at 100 keeps its title");
    hundred.put("https://extra.test/");
    refused(hundred.toString(), "an over-long record");
    throwsOn(IllegalArgumentException.class, () -> BrowserBookmarkRecord.change(new ArrayList<>(), "http://a.test/", true, "A", VALID), "an invalid address is refused");
    System.out.println(assertions + " assertions passed");
  }
}
