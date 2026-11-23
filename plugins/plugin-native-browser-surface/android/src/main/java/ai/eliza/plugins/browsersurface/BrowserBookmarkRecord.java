package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The plain form of the sealed bookmark record, newest first. A row without a title is the bare
 * address string, exactly as earlier builds wrote every row; a row with a title is
 * {@code {"url":"https://…","title":"…"}}. A record without titles is therefore unchanged, and a
 * record written by an earlier build reads back with no titles. Titles are display text the host
 * supplies: control characters become spaces, surrounding whitespace is trimmed, and at most
 * {@link #MAX_TITLE} characters are kept. A record that is too long, holds an invalid or repeated
 * address, or a title that is not in that form is damaged and refused as a whole. Only org.json,
 * no Android types: host-tested by javac.
 */
public final class BrowserBookmarkRecord {
  public static final int MAX = 100;
  public static final int MAX_TITLE = 300;

  private BrowserBookmarkRecord() {}

  /** One bookmark. {@code title} is null when none was saved. */
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

  /**
   * The stored form of a supplied title, or null for none: control characters become spaces,
   * surrounding whitespace is trimmed and the text is cut to {@link #MAX_TITLE} characters without
   * splitting a surrogate pair. Blank text is no title.
   */
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

  /**
   * Bookmarks from the opened record, newest first; {@code null} is no record. Throws when the
   * record is damaged. {@code valid} is the host store's address rule.
   */
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

  /** The record to seal. Rows without a title are written as bare addresses. */
  public static String write(List<Entry> entries) throws Exception {
    JSONArray json = new JSONArray();
    for (Entry entry : entries) {
      if (entry.title == null) json.put(entry.url);
      else json.put(new JSONObject().put("url", entry.url).put("title", entry.title));
    }
    return json.toString();
  }

  /**
   * Saves {@code url} first, or removes it. {@code title} null keeps the title the address already
   * has (none for a new bookmark); otherwise it is replaced by {@link #title(String)} of it, so a
   * blank title removes it. The title is ignored when removing. Throws for an invalid address or
   * when a new bookmark would exceed {@link #MAX}.
   */
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
