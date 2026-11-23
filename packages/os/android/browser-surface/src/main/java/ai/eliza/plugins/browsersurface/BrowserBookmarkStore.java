package ai.eliza.plugins.browsersurface;

import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

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
  private static final String TITLES_KEY = "sealed_titles";
  private static final int MAX_TITLE_UNITS = 300;
  private final SharedPreferences preferences;
  private final BrowserSealedText sealer;

  public static final class Entry {
    public final String url;
    public final String title;

    Entry(String url, String title) {
      this.url = url;
      this.title = title;
    }
  }

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
    ArrayList<String> urls = new ArrayList<>();
    for (Entry entry : entries()) urls.add(entry.url);
    return urls;
  }

  public synchronized ArrayList<Entry> entries() throws Exception {
    String addresses = preferences.getString(KEY, null);
    String sealedTitles = preferences.getString(TITLES_KEY, null);
    if (addresses == null && sealedTitles != null) throw new IllegalStateException();
    JSONArray rows = addresses == null ? new JSONArray() : new JSONArray(sealer.open(addresses));
    if (rows.length() > MAX) throw new IllegalStateException();
    JSONArray titles = new JSONArray();
    if (sealedTitles != null) {
      JSONArray companion = new JSONArray(sealer.open(sealedTitles));
      if (companion.length() != 2 || !(companion.get(0) instanceof String)) throw new IllegalStateException();
      if (revision(addresses).equals(companion.get(0))) {
        titles = companion.getJSONArray(1);
        if (titles.length() != rows.length()) throw new IllegalStateException();
      }
    }
    ArrayList<Entry> result = new ArrayList<>();
    ArrayList<String> seen = new ArrayList<>();
    for (int i = 0; i < rows.length(); i++) {
      if (!(rows.get(i) instanceof String url) || !valid(url) || seen.contains(url)) throw new IllegalStateException();
      Object title = titles.opt(i);
      if (title == null || title == JSONObject.NULL) result.add(new Entry(url, null));
      else if (title instanceof String value && value.equals(normalizedTitle(value))) result.add(new Entry(url, value));
      else throw new IllegalStateException();
      seen.add(url);
    }
    return result;
  }

  /** Saves {@code url} first, or removes it. Returns the stored list; nothing changes on failure. */
  public synchronized ArrayList<String> change(String url, boolean saved) throws Exception {
    ArrayList<String> urls = new ArrayList<>();
    for (Entry entry : change(url, saved, null)) urls.add(entry.url);
    return urls;
  }

  public synchronized ArrayList<Entry> change(String url, boolean saved, String title) throws Exception {
    if (!valid(url)) throw new IllegalArgumentException();
    ArrayList<Entry> rows = entries();
    String existing = null;
    for (int i = 0; i < rows.size(); i++) {
      if (rows.get(i).url.equals(url)) {
        existing = rows.remove(i).title;
        break;
      }
    }
    if (saved) {
      if (rows.size() >= MAX) throw new IllegalStateException();
      rows.add(0, new Entry(url, title == null ? existing : normalizedTitle(title)));
    }
    JSONArray addresses = new JSONArray();
    JSONArray titles = new JSONArray();
    boolean hasTitles = false;
    for (Entry entry : rows) {
      addresses.put(entry.url);
      titles.put(entry.title == null ? JSONObject.NULL : entry.title);
      hasTitles |= entry.title != null;
    }
    String sealedAddresses = sealer.seal(addresses.toString());
    SharedPreferences.Editor edit = preferences.edit().putString(KEY, sealedAddresses);
    if (hasTitles) edit.putString(TITLES_KEY, sealer.seal(new JSONArray().put(revision(sealedAddresses)).put(titles).toString()));
    else edit.remove(TITLES_KEY);
    if (!edit.commit()) throw new IllegalStateException();
    return rows;
  }

  private static String normalizedTitle(String value) {
    String clean = BrowserSessionPolicy.title(value);
    if (clean.length() > MAX_TITLE_UNITS) {
      int end = MAX_TITLE_UNITS;
      if (Character.isHighSurrogate(clean.charAt(end - 1))) end--;
      clean = clean.substring(0, end).trim();
    }
    return clean.isEmpty() ? null : clean;
  }

  private static String revision(String sealedAddresses) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(sealedAddresses.getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(digest, Base64.NO_WRAP);
  }
}
