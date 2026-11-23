package ai.eliza.plugins.browsersurface;

import android.content.SharedPreferences;
import android.net.Uri;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Explicit bookmarks only: at most {@link #MAX} HTTPS addresses without embedded credentials,
 * newest first, each with an optional host-supplied title ({@link BrowserBookmarkRecord}). No page
 * content, history or cookies. Addresses can carry private query parameters and titles name what
 * was saved, so the records are sealed by the host's {@link BrowserSealedText}. The host
 * chooses the preferences file (and the seal's key) so installed data keeps its name; the record
 * lives under {@link #KEY}. The optional title record is bound to the exact seal of that record.
 * A damaged address record is reported, never silently replaced.
 */
public final class BrowserBookmarkStore {
  public static final int MAX = BrowserBookmarkRecord.MAX;
  public static final String KEY = "sealed";
  private static final String TITLES_KEY = "sealed-titles";
  private final SharedPreferences preferences;
  private final BrowserSealedText sealer;

  public BrowserBookmarkStore(SharedPreferences preferences, BrowserSealedText sealer) {
    this.preferences = preferences;
    this.sealer = sealer;
  }

  /** HTTPS with a host, no user info, no whitespace or control characters, at most 4096 chars. */
  public static boolean valid(String value) {
    if (value == null || value.isEmpty() || value.length() > 4096
        || value.matches("(?s).*[\\x00-\\x20\\x7f].*")) return false;
    try {
      Uri uri = Uri.parse(value);
      return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
          && uri.getUserInfo() == null;
    } catch (Exception invalid) {
      return false;
    }
  }

  /** Saved bookmark addresses, newest first. Throws when the record is damaged or cannot be opened. */
  public synchronized ArrayList<String> read() throws Exception {
    return urls(entries());
  }

  /**
   * Saved bookmarks with their optional titles, newest first. A record written by an earlier
   * build reads back with no titles. Throws when the record is damaged or cannot be opened.
   */
  public synchronized List<BrowserBookmarkRecord.Entry> entries() throws Exception {
    String packed = preferences.getString(KEY, null);
    if (packed == null) return new ArrayList<>();
    List<BrowserBookmarkRecord.Entry> rows =
        BrowserBookmarkRecord.read(sealer.open(packed), BrowserBookmarkStore::valid);
    String sealedTitles = preferences.getString(TITLES_KEY, null);
    if (sealedTitles == null) return rows;
    JSONObject titles = new JSONObject(sealer.open(sealedTitles));
    if (!fingerprint(packed).equals(titles.getString("addresses"))) return rows;
    return BrowserBookmarkRecord.withTitles(rows, titles.getJSONArray("titles"));
  }

  /** Saves {@code url} first, or removes it, and returns the committed list. */
  public synchronized ArrayList<String> change(String url, boolean saved) throws Exception {
    return urls(change(url, saved, null));
  }

  /**
   * Saves {@code url} first with an optional title, or removes it. A null {@code title} keeps the
   * title the address already has; a blank one removes it ({@link BrowserBookmarkRecord#change}).
   * The title record commits together with the addresses. Returns the stored list.
   */
  public synchronized List<BrowserBookmarkRecord.Entry> change(String url, boolean saved, String title)
      throws Exception {
    if (!valid(url)) throw new IllegalArgumentException();
    List<BrowserBookmarkRecord.Entry> rows =
        BrowserBookmarkRecord.change(entries(), url, saved, title, BrowserBookmarkStore::valid);
    String packed = sealer.seal(BrowserBookmarkRecord.write(rows));
    String packedTitles = null;
    if (rows.stream().anyMatch(entry -> entry.title != null)) {
      JSONObject titles = new JSONObject()
          .put("addresses", fingerprint(packed))
          .put("titles", BrowserBookmarkRecord.titles(rows));
      packedTitles = sealer.seal(titles.toString());
    }
    if (!preferences.edit().putString(KEY, packed).putString(TITLES_KEY, packedTitles).commit())
      throw new IllegalStateException();
    return rows;
  }

  private static String fingerprint(String packed) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(packed.getBytes(StandardCharsets.UTF_8));
    return new BigInteger(1, digest).toString(16);
  }

  private static ArrayList<String> urls(List<BrowserBookmarkRecord.Entry> entries) {
    ArrayList<String> result = new ArrayList<>();
    for (BrowserBookmarkRecord.Entry entry : entries) result.add(entry.url);
    return result;
  }
}
