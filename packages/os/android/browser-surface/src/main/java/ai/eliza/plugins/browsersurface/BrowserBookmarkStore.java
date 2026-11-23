package ai.eliza.plugins.browsersurface;

import android.content.SharedPreferences;
import android.net.Uri;
import java.util.ArrayList;
import java.util.List;

/**
 * Explicit bookmarks only: at most {@link #MAX} HTTPS addresses without embedded credentials,
 * newest first, each with an optional host-supplied title ({@link BrowserBookmarkRecord}). No page
 * content, history or cookies. Addresses can carry private query parameters and titles name what
 * was saved, so the whole record is sealed by the host's {@link BrowserSealedText}. The host
 * chooses the preferences file (and the seal's key) so installed data keeps its name; the record
 * lives under {@link #KEY}. A damaged record is reported, never silently replaced.
 */
public final class BrowserBookmarkStore {
  public static final int MAX = BrowserBookmarkRecord.MAX;
  public static final String KEY = "sealed";
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

  /** Saved bookmarks, newest first. Throws when the record is damaged or cannot be opened. */
  public synchronized ArrayList<String> read() throws Exception {
    return urls(entries());
  }

  public synchronized List<BrowserBookmarkRecord.Entry> entries() throws Exception {
    String packed = preferences.getString(KEY, null);
    if (packed == null) return new ArrayList<>();
    return BrowserBookmarkRecord.read(sealer.open(packed), BrowserBookmarkStore::valid);
  }

  /** Saves {@code url} first, or removes it. Returns the stored list; nothing changes on failure. */
  public synchronized ArrayList<String> change(String url, boolean saved) throws Exception {
    return urls(change(url, saved, null));
  }

  public synchronized List<BrowserBookmarkRecord.Entry> change(String url, boolean saved, String title)
      throws Exception {
    if (!valid(url)) throw new IllegalArgumentException();
    List<BrowserBookmarkRecord.Entry> rows =
        BrowserBookmarkRecord.change(entries(), url, saved, title, BrowserBookmarkStore::valid);
    if (!preferences.edit().putString(KEY, sealer.seal(BrowserBookmarkRecord.write(rows))).commit())
      throw new IllegalStateException();
    return rows;
  }

  private static ArrayList<String> urls(List<BrowserBookmarkRecord.Entry> entries) {
    ArrayList<String> result = new ArrayList<>();
    for (BrowserBookmarkRecord.Entry entry : entries) result.add(entry.url);
    return result;
  }
}
