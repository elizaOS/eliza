package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;

/**
 * Generic restore policy for a browser surface with one persistent profile and ephemeral (private)
 * tabs: which tabs, history entries and bookmarks may be written to the host's sealed store, and
 * how a damaged or hostile record is read back.
 *
 * <ul>
 *   <li>Ephemeral tabs and their navigations are never part of a persisted snapshot or history.
 *   <li>Tabs and history accept http(s) addresses without user info, control characters or
 *       whitespace, at most {@link #MAX_URL} characters; bookmarks accept https only.
 *   <li>Lists are de-duplicated; invalid snapshot rows are dropped, while a
 *       bookmark record that does not validate is refused as a whole (the host treats it as
 *       damaged rather than silently losing entries).
 *   <li>Clear data for a site removes history and bookmarks for that host and its subdomains.
 * </ul>
 *
 * <p>The host owns encryption, storage, tab views and the UI. Pure JVM; no Android types.
 */
public final class BrowserSessionPolicy {
  public static final int MAX_URL = 4096;
  public static final int MAX_BOOKMARKS = 100;

  private BrowserSessionPolicy() {}

  /** A tab as the host sees it. {@code ephemeral} is true for a private tab. */
  public static final class Tab {
    public final String id;
    public final String url;
    public final String title;
    public final boolean ephemeral;

    public Tab(String id, String url, String title, boolean ephemeral) {
      this.id = id;
      this.url = url;
      this.title = title;
      this.ephemeral = ephemeral;
    }

    @Override
    public boolean equals(Object other) {
      if (!(other instanceof Tab))
        return false;
      Tab tab = (Tab) other;
      return ephemeral == tab.ephemeral && Objects.equals(id, tab.id)
          && Objects.equals(url, tab.url) && Objects.equals(title, tab.title);
    }

    @Override
    public int hashCode() {
      return Objects.hash(id, url, title, ephemeral);
    }
  }

  /** A canonical, persistable snapshot: persistent-profile tabs only. */
  public static final class Snapshot {
    public final List<Tab> tabs;
    public final List<String> history;
    /** Id of the selected tab when it is persisted, otherwise the empty string. */
    public final String current;

    Snapshot(List<Tab> tabs, List<String> history, String current) {
      this.tabs = Collections.unmodifiableList(tabs);
      this.history = Collections.unmodifiableList(history);
      this.current = current;
    }
  }

  private static String origin(String value) {
    return value == null || value.length() > MAX_URL ? null : BrowserWebOrigin.of(value);
  }

  /** An address a restored tab or history entry may hold. */
  public static boolean validUrl(String value) {
    return origin(value) != null;
  }

  /** An address a bookmark may hold: https only. */
  public static boolean validBookmark(String value) {
    String origin = origin(value);
    return origin != null && origin.startsWith("https://");
  }

  public static boolean validTabId(String value) {
    return value != null && value.matches("[A-Za-z0-9_-]{1,80}");
  }

  /**
   * Control characters become spaces; surrounding whitespace is trimmed. Titles are not truncated.
   */
  public static String title(String value) {
    if (value == null)
      return "";
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      out.append(c < 32 || c == 127 ? ' ' : c);
    }
    return out.toString().trim();
  }

  /**
   * The snapshot the host may persist. Ephemeral tabs are dropped first, then invalid or duplicate
   * rows. All valid persistent tabs and history entries are kept in their given order. {@code
   * current} survives only if it names a kept tab.
   */
  public static Snapshot persistable(List<Tab> tabs, List<String> history, String current) {
    List<Tab> keptTabs = new ArrayList<>();
    LinkedHashSet<String> ids = new LinkedHashSet<>();
    if (tabs != null) {
      for (Tab tab : tabs) {
        if (tab == null || tab.ephemeral || !validTabId(tab.id) || !validUrl(tab.url)
            || !ids.add(tab.id))
          continue;
        keptTabs.add(new Tab(tab.id, tab.url, title(tab.title), false));
      }
    }
    List<String> keptHistory = new ArrayList<>();
    LinkedHashSet<String> seen = new LinkedHashSet<>();
    if (history != null) {
      for (String url : history) {
        if (validUrl(url) && seen.add(url))
          keptHistory.add(url);
      }
    }
    return new Snapshot(
        keptTabs, keptHistory, current != null && ids.contains(current) ? current : "");
  }

  /** A restored record goes through the same rules: nothing from it is trusted. */
  public static Snapshot restore(List<Tab> tabs, List<String> history, String current) {
    return persistable(tabs, history, current);
  }

  /**
   * History after a committed navigation. An ephemeral tab's navigation, or an address that is not
   * valid, returns the history unchanged. The newest entry is first and an address appears once.
   */
  public static List<String> recordVisit(List<String> history, String url, boolean ephemeral) {
    List<String> current = history == null ? new ArrayList<>() : new ArrayList<>(history);
    if (ephemeral || !validUrl(url))
      return current;
    current.remove(url);
    current.add(0, url);
    return current;
  }

  /** True when {@code url}'s host is {@code site} or one of its subdomains. */
  public static boolean belongsToSite(String url, String site) {
    String origin = origin(url);
    return origin != null && BrowserWebOrigin.withinSite(origin, site);
  }

  /** History or bookmarks without the entries for {@code site} (Clear data for this site). */
  public static List<String> withoutSite(List<String> urls, String site) {
    List<String> kept = new ArrayList<>();
    if (urls == null)
      return kept;
    for (String url : urls)
      if (!belongsToSite(url, site))
        kept.add(url);
    return kept;
  }

  /**
   * Validates a stored bookmark list. A list that is too long, holds an invalid address or a
   * duplicate is refused with {@link IllegalStateException}; the host reports a damaged record.
   */
  public static List<String> restoreBookmarks(List<String> stored) {
    List<String> result = new ArrayList<>();
    if (stored == null)
      return result;
    if (stored.size() > MAX_BOOKMARKS)
      throw new IllegalStateException("too many bookmarks");
    for (String url : stored) {
      if (!validBookmark(url) || result.contains(url))
        throw new IllegalStateException("damaged bookmark record");
      result.add(url);
    }
    return result;
  }

  /**
   * Adds (newest first) or removes a bookmark. An invalid address is refused with {@link
   * IllegalArgumentException}; adding beyond {@link #MAX_BOOKMARKS} with {@link
   * IllegalStateException}. Bookmarks are explicit user actions, so an ephemeral tab may add one;
   * the host decides whether to offer that.
   */
  public static List<String> changeBookmark(List<String> stored, String url, boolean saved) {
    if (!validBookmark(url))
      throw new IllegalArgumentException("invalid bookmark");
    List<String> rows = restoreBookmarks(stored);
    rows.remove(url);
    if (saved) {
      if (rows.size() >= MAX_BOOKMARKS)
        throw new IllegalStateException("bookmark limit");
      rows.add(0, url);
    }
    return rows;
  }
}
