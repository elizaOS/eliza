import ai.eliza.plugins.browsersurface.BrowserDownloadPolicy;
import ai.eliza.plugins.browsersurface.BrowserDownloadPolicy.Entry;
import ai.eliza.plugins.browsersurface.BrowserDownloadPolicy.History;
import ai.eliza.plugins.browsersurface.BrowserSitePermissions;
import ai.eliza.plugins.browsersurface.BrowserWebOrigin;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Plain-JVM checks for the browser-surface web policy (run by web-policy.node.mjs). */
public final class BrowserWebPolicyTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  private static void equal(Object expected, Object actual, String message) {
    check(expected == null ? actual == null : expected.equals(actual),
        message + ": expected " + expected + " but was " + actual);
  }

  private static void throwsIllegal(Runnable action, String message) {
    try {
      action.run();
    } catch (IllegalArgumentException expected) {
      assertions++;
      return;
    }
    throw new AssertionError(message);
  }

  private static void origins() {
    equal("https://example.com", BrowserWebOrigin.of("https://Example.COM/path?q#f"),
        "lower case, path dropped");
    equal("https://example.com", BrowserWebOrigin.of("https://example.com:443/"),
        "default https port elided");
    equal("http://example.com", BrowserWebOrigin.of("http://example.com:80/"),
        "default http port elided");
    equal("https://example.com:8443", BrowserWebOrigin.of("https://example.com:8443/x"),
        "explicit port kept");
    equal("http://example.com:443", BrowserWebOrigin.of("http://example.com:443/"),
        "443 is not http's default");
    equal("https://[::1]:8443", BrowserWebOrigin.of("https://[::1]:8443/"), "IPv6 host");
    equal(null, BrowserWebOrigin.of("https://user:pw@example.com/"), "user info has no origin");
    equal(null, BrowserWebOrigin.of("ftp://example.com/"), "only http(s)");
    equal(null, BrowserWebOrigin.of("javascript:alert(1)"), "javascript:");
    equal(null, BrowserWebOrigin.of("file:///sdcard/x"), "file:");
    equal(null, BrowserWebOrigin.of("https:///nohost"), "no host");
    equal(null, BrowserWebOrigin.of("https://example.com/\nx"), "control characters");
    equal(null, BrowserWebOrigin.of(null), "null");
    char[] longPath = new char[BrowserWebOrigin.MAX_URL];
    Arrays.fill(longPath, 'a');
    equal(null, BrowserWebOrigin.of("https://example.com/" + new String(longPath)),
        "over-long address");
    equal("https://example.com", BrowserWebOrigin.blobOwner("blob:https://example.com/7d3c-uuid"),
        "blob owner");
    equal(null, BrowserWebOrigin.blobOwner("blob:null/7d3c"), "opaque blob owner");
    equal(null, BrowserWebOrigin.blobOwner("https://example.com/"), "not a blob");
    check(BrowserWebOrigin.sameOrigin("https://example.com/a", "https://EXAMPLE.com:443/b"),
        "same origin");
    check(!BrowserWebOrigin.sameOrigin("https://example.com/", "https://sub.example.com/"),
        "subdomain differs");
    check(!BrowserWebOrigin.sameOrigin("https://example.com/", "http://example.com/"),
        "scheme differs");
    check(!BrowserWebOrigin.sameOrigin("data:,x", "data:,x"), "no origin is never the same origin");
    equal("example.com", BrowserWebOrigin.host("https://example.com:8443"), "host without port");
    equal("[::1]", BrowserWebOrigin.host("https://[::1]:8443"), "IPv6 host keeps brackets");
    check(BrowserWebOrigin.withinSite("https://a.b.example.com", "example.com"),
        "subdomain within site");
    check(BrowserWebOrigin.withinSite("https://example.com:8443", "EXAMPLE.com"),
        "site itself, any port");
    check(!BrowserWebOrigin.withinSite("https://notexample.com", "example.com"),
        "suffix without a dot is another site");
    check(!BrowserWebOrigin.withinSite("https://example.com", ""), "empty site clears nothing");
  }

  private static void cookies() {
    check(BrowserDownloadPolicy.cookieAllowed(
              "https://example.com/file.pdf", "https://example.com", true),
        "same origin, tab open");
    check(!BrowserDownloadPolicy.cookieAllowed(
              "https://example.com/file.pdf", "https://example.com", false),
        "closed tab supplies nothing");
    check(!BrowserDownloadPolicy.cookieAllowed(
              "https://cdn.example.com/file.pdf", "https://example.com", true),
        "other subdomain");
    check(!BrowserDownloadPolicy.cookieAllowed(
              "https://example.com:8443/file", "https://example.com", true),
        "other port");
    check(!BrowserDownloadPolicy.cookieAllowed(
              "http://example.com/file", "https://example.com", true),
        "other scheme");
    check(!BrowserDownloadPolicy.cookieAllowed("https://example.com/file", null, true),
        "no committed page");
    check(!BrowserDownloadPolicy.cookieAllowed(
              "https://user@example.com/file", "https://example.com", true),
        "user info");
    check(
        BrowserDownloadPolicy.cookieHeaderAcceptable("sid=abc; theme=dark"), "single-line cookie");
    check(!BrowserDownloadPolicy.cookieHeaderAcceptable("sid=abc\r\nX-Injected: 1"),
        "header injection refused");
    check(!BrowserDownloadPolicy.cookieHeaderAcceptable(""), "empty cookie not attached");
  }

  private static void names() {
    equal("report_2026_.pdf", BrowserDownloadPolicy.sanitizeName("report<2026>.pdf"),
        "unsafe characters replaced");
    equal("hidden", BrowserDownloadPolicy.sanitizeName("..hidden"), "never hidden");
    equal("download", BrowserDownloadPolicy.sanitizeName(" . "), "empty becomes download");
    equal("download", BrowserDownloadPolicy.sanitizeName(null), "null becomes download");
    equal(BrowserDownloadPolicy.MAX_NAME,
        BrowserDownloadPolicy.sanitizeName(new String(new char[300]).replace('\0', 'x')).length(),
        "bounded length");
    equal("_.._etc_passwd", BrowserDownloadPolicy.sanitizeName("/../etc/passwd"),
        "no path separators");
    check(BrowserDownloadPolicy.validMime("application/pdf"), "valid mime");
    check(!BrowserDownloadPolicy.validMime("text/html; charset=utf-8"),
        "parameters are not a mime type");
    check(!BrowserDownloadPolicy.validMime("text"), "no subtype");
  }

  private static void data() {
    equal("hello",
        new String(BrowserDownloadPolicy.decodeData("data:;base64,aGVsbG8=#ignored"),
            StandardCharsets.UTF_8),
        "fragment excluded");
    equal("a#b",
        new String(BrowserDownloadPolicy.decodeData("data:,a%23b#ignored"), StandardCharsets.UTF_8),
        "escaped fragment delimiter kept");
    equal("aGVsbG8=",
        new String(BrowserDownloadPolicy.decodeData("data:;base64;charset=utf-8,aGVsbG8="),
            StandardCharsets.UTF_8),
        "base64 only applies as final metadata marker");
    throwsIllegal(()
                      -> BrowserDownloadPolicy.decodeData("data:text/plain#fragment,x"),
        "fragment cannot supply data separator");
    throwsIllegal(
        () -> BrowserDownloadPolicy.decodeData("data:;base64,aGVs!bG8="), "junk in base64 refused");
    check(!BrowserDownloadPolicy.cookieHeaderAcceptable("name=value\u0000other"),
        "NUL cookie refused");
    equal(null, BrowserWebOrigin.of("https://example.test:65536/"), "invalid port refused");
    equal("hello",
        new String(BrowserDownloadPolicy.decodeData("data:text/plain;base64,aGVsbG8="),
            StandardCharsets.UTF_8),
        "base64");
    equal("hello",
        new String(BrowserDownloadPolicy.decodeData("data:text/plain;base64,aGVsbG8"),
            StandardCharsets.UTF_8),
        "base64 without padding");
    equal("hello",
        new String(
            BrowserDownloadPolicy.decodeData("data:;base64,aGVs%0AbG8="), StandardCharsets.UTF_8),
        "percent-encoded line break ignored");
    equal("a b+c",
        new String(BrowserDownloadPolicy.decodeData("data:,a%20b+c"), StandardCharsets.UTF_8),
        "percent-decoding keeps plus");
    equal("é",
        new String(BrowserDownloadPolicy.decodeData("data:text/plain;charset=utf-8,%C3%A9"),
            StandardCharsets.UTF_8),
        "UTF-8 bytes");
    equal("100%",
        new String(BrowserDownloadPolicy.decodeData("data:,100%"), StandardCharsets.UTF_8),
        "malformed escape stays literal");
    equal("text/csv", BrowserDownloadPolicy.dataMime("data:TEXT/CSV;charset=utf-8,a,b"),
        "declared type");
    equal(null, BrowserDownloadPolicy.dataMime("data:,x"), "no declared type");
    throwsIllegal(() -> BrowserDownloadPolicy.decodeData("https://example.com/"), "not data");
    throwsIllegal(() -> BrowserDownloadPolicy.decodeData("data:text/plain"), "no comma");
    throwsIllegal(() -> BrowserDownloadPolicy.decodeData("data:;base64,a"), "truncated base64");
  }

  private static void history() {
    History history = new History();
    check(history.add(new Entry(1, "a.pdf", "https://example.com", false, null)), "normal entry");
    check(history.add(new Entry(2, "b.pdf", "https://private.example.org", true, "tab-p")),
        "private entry");
    check(history.add(new Entry(-1, "c.bin", "https://sub.example.com", false, "ignored")),
        "captured file entry");
    equal(3, history.all().size(), "all entries listed in memory");
    List<Entry> durable = history.persistable();
    equal(2, durable.size(), "private entry never persisted");
    for (Entry entry : durable) {
      check(!entry.ephemeral, "persisted entries are normal");
      check(!entry.origin.contains("private.example.org"), "no private origin in durable entries");
      equal(null, entry.tab, "normal entries do not keep a tab id");
    }
    check(!history.forgetEphemeralTab("tab-other"), "other tab forgets nothing");
    check(history.forgetEphemeralTab("tab-p"), "closing the private tab forgets its entries");
    equal(2, history.all().size(), "only normal entries remain");
    check(history.clearSite("example.com"), "site clearing removes site and subdomains");
    equal(0, history.all().size(), "site cleared");
    History restored = new History();
    restored.restore(Arrays.asList(new Entry(5, "x", "https://example.com", true, "old-tab"),
        new Entry(6, "y", "https://example.com", false, null)));
    equal(1, restored.all().size(), "a stored private entry from an older build is never restored");
    for (int i = 0; i < History.MAX_ENTRIES; i++)
      restored.add(new Entry(100 + i, "n", "https://example.com", false, null));
    check(restored.full(), "bounded");
    check(!restored.add(new Entry(999, "n", "https://example.com", false, null)),
        "full list refuses");
    List<Entry> retained = new java.util.ArrayList<>();
    for (int i = 0; i < 75; i++)
      retained.add(new Entry(1000 + i, "saved", "https://example.com", false, null));
    restored.restore(retained);
    equal(75, restored.all().size(), "older download history is not discarded on restore");
    restored.clear();
    equal(0, restored.all().size(), "clear browsing data clears both profiles");
    throwsIllegal(() -> new Entry(0, "n", "https://example.com", false, null), "zero id");
    throwsIllegal(
        () -> new Entry(7, "n", "https://example.com", true, null), "private entry needs its tab");
  }

  private static void permissions() {
    BrowserSitePermissions permissions = new BrowserSitePermissions();
    equal(null, permissions.decision("https://example.com/call", "camera", false), "unknown asks");
    check(permissions.record("https://example.com/call", "camera", true, false),
        "normal tab records");
    check(permissions.record("https://example.com/other", "microphone", false, false),
        "deny recorded");
    equal(Boolean.TRUE, permissions.decision("https://example.com/x", "camera", false),
        "allow for origin");
    equal(Boolean.FALSE, permissions.decision("https://example.com/x", "microphone", false),
        "deny for origin");
    equal(null, permissions.decision("https://example.com/x", "camera", true),
        "private tab never reads a decision");
    equal(null, permissions.decision("https://sub.example.com/x", "camera", false),
        "decisions are per exact origin");
    check(!permissions.record("https://private.example.org/", "location", true, true),
        "private tab never records");
    check(
        !permissions.origins().contains("https://private.example.org"), "no private origin stored");
    check(!permissions.record("https://example.com/", "notifications", true, false),
        "unknown kind refused");
    check(!permissions.record("data:,x", "camera", true, false), "no origin refused");
    Map<String, Map<String, Boolean>> snapshot = permissions.snapshot();
    BrowserSitePermissions restored = BrowserSitePermissions.restore(snapshot);
    equal(Boolean.TRUE, restored.decision("https://example.com/", "camera", false),
        "snapshot round trip");
    Map<String, Map<String, Boolean>> tampered = new LinkedHashMap<>();
    Map<String, Boolean> grant = new LinkedHashMap<>();
    grant.put("camera", true);
    grant.put("everything", true);
    tampered.put("https://EVIL.example/path", grant);
    tampered.put("https://ok.example", grant);
    BrowserSitePermissions filtered = BrowserSitePermissions.restore(tampered);
    equal(Arrays.asList("https://ok.example"), filtered.origins(),
        "non-canonical origins grant nothing");
    equal(null, filtered.decision("https://ok.example/", "everything", false),
        "unknown kinds grant nothing");
    check(permissions.clearSite("example.com"), "clear data for this site revokes");
    equal(null, permissions.decision("https://example.com/", "camera", false), "revoked");
    for (int i = 0; i < BrowserSitePermissions.MAX_ORIGINS + 5; i++)
      permissions.record("https://s" + i + ".example.net/", "location", true, false);
    equal(BrowserSitePermissions.MAX_ORIGINS, permissions.origins().size(), "bounded origins");
    equal(null, permissions.decision("https://s0.example.net/", "location", false),
        "oldest origin evicted first");
    equal(Boolean.TRUE, permissions.decision("https://s204.example.net/", "location", false),
        "newest kept");
    permissions.clear();
    equal(0, permissions.origins().size(), "clear browsing data revokes everything");
  }

  public static void main(String[] args) {
    origins();
    cookies();
    names();
    data();
    history();
    permissions();
    System.out.println(assertions + " assertions passed");
  }
}
