package ai.eliza.plugins.browsersurface;

import android.content.SharedPreferences;
import android.net.Uri;
import java.util.ArrayList;
import org.json.JSONArray;

/**
 * Explicit bookmarks only: at most {@link #MAX} HTTPS addresses without embedded credentials,
 * newest first. No page content, history or cookies. Addresses can carry private query
 * parameters, so the record is sealed by the host's {@link BrowserSealedText}. The host chooses
 * the preferences file (and the seal's key) so installed data keeps its name; the record lives
 * under {@link #KEY}. A damaged record is reported, never silently replaced.
 */
public final class BrowserBookmarkStore {
  public static final int MAX = 100;
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
    String packed = preferences.getString(KEY, null);
    ArrayList<String> result = new ArrayList<>();
    if (packed == null) return result;
    JSONArray rows = new JSONArray(sealer.open(packed));
    if (rows.length() > MAX) throw new IllegalStateException();
    for (int i = 0; i < rows.length(); i++) {
      String value = rows.getString(i);
      if (!valid(value) || result.contains(value)) throw new IllegalStateException();
      result.add(value);
    }
    return result;
  }

  /** Saves {@code url} first, or removes it. Returns the stored list; nothing changes on failure. */
  public synchronized ArrayList<String> change(String url, boolean saved) throws Exception {
    if (!valid(url)) throw new IllegalArgumentException();
    ArrayList<String> rows = read();
    rows.remove(url);
    if (saved) {
      if (rows.size() >= MAX) throw new IllegalStateException();
      rows.add(0, url);
    }
    JSONArray json = new JSONArray();
    for (String value : rows) json.put(value);
    if (!preferences.edit().putString(KEY, sealer.seal(json.toString())).commit())
      throw new IllegalStateException();
    return rows;
  }
}
