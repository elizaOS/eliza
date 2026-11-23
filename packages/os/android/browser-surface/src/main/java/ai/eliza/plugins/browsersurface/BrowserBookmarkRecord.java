package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BrowserBookmarkRecord {
  public static final int MAX = 100;
  public static final int MAX_TITLE = 300;

  private BrowserBookmarkRecord() {}

  public static final class Entry {
    public final String url;
    public final String title;

    public Entry(String url, String title) {
      this.url = url;
      this.title = title;
    }

    @Override
    public boolean equals(Object other) {
      if (!(other instanceof Entry)) return false;
      Entry entry = (Entry) other;
      return Objects.equals(url, entry.url) && Objects.equals(title, entry.title);
    }

    @Override
    public int hashCode() {
      return Objects.hash(url, title);
    }

    @Override
    public String toString() {
      return title == null ? url : url + " (" + title + ")";
    }
  }

  public static String title(String value) {
    if (value == null) return null;
    String clean = BrowserSessionPolicy.title(value);
    if (clean.length() > MAX_TITLE) {
      int end = MAX_TITLE;
      if (Character.isHighSurrogate(clean.charAt(end - 1))) end--;
      clean = clean.substring(0, end).trim();
    }
    return clean.isEmpty() ? null : clean;
  }

  private static boolean storedTitle(String value) {
    return value != null && value.equals(title(value));
  }

  public static List<Entry> read(String json, Predicate<String> valid) throws Exception {
    List<Entry> result = new ArrayList<>();
    if (json == null) return result;
    JSONArray rows = new JSONArray(json);
    if (rows.length() > MAX) throw new IllegalStateException("too many bookmarks");
    List<String> seen = new ArrayList<>();
    for (int i = 0; i < rows.length(); i++) {
      Object row = rows.get(i);
      String url;
      String title = null;
      if (row instanceof String) {
        url = (String) row;
      } else if (row instanceof JSONObject) {
        JSONObject object = (JSONObject) row;
        Object rawUrl = object.opt("url");
        Object rawTitle = object.opt("title");
        if (!(rawUrl instanceof String) || !(rawTitle instanceof String)
            || !storedTitle((String) rawTitle))
          throw new IllegalStateException("damaged bookmark record");
        url = (String) rawUrl;
        title = (String) rawTitle;
      } else {
        throw new IllegalStateException("damaged bookmark record");
      }
      if (!valid.test(url) || seen.contains(url))
        throw new IllegalStateException("damaged bookmark record");
      seen.add(url);
      result.add(new Entry(url, title));
    }
    return result;
  }

  public static String write(List<Entry> entries) throws Exception {
    JSONArray json = new JSONArray();
    for (Entry entry : entries) {
      if (entry.title == null) json.put(entry.url);
      else json.put(new JSONObject().put("url", entry.url).put("title", entry.title));
    }
    return json.toString();
  }

  public static List<Entry> change(
      List<Entry> stored, String url, boolean saved, String title, Predicate<String> valid) {
    if (!valid.test(url)) throw new IllegalArgumentException("invalid bookmark");
    List<Entry> rows = new ArrayList<>(stored);
    String kept = null;
    for (int i = 0; i < rows.size(); i++)
      if (rows.get(i).url.equals(url)) {
        kept = rows.remove(i).title;
        break;
      }
    if (saved) {
      if (rows.size() >= MAX) throw new IllegalStateException("bookmark limit");
      rows.add(0, new Entry(url, title == null ? kept : title(title)));
    }
    return Collections.unmodifiableList(rows);
  }
}
