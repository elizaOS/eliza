package ai.eliza.plugins.browsersurface;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.function.Predicate;

/**
 * Generic download policy for a browser surface with persistent and ephemeral (private) profiles.
 *
 * <p>The host owns the review UI, its wording, storage locations and the OS download service.
 * This class owns the decisions every host must make the same way:
 *
 * <ul>
 *   <li>A download carries the requesting tab's profile cookie only for the exact origin of that
 *       tab's committed page, and only while that tab is still open.
 *   <li>{@code data:} files are decoded natively, never through page script, within {@link
 *       #MAX_CAPTURE}.
 *   <li>Download history entries from an ephemeral profile are never persisted and are forgotten
 *       when their tab closes; clearing browsing data or a site clears the history too.
 * </ul>
 *
 * Pure JVM; no Android types.
 */
public final class BrowserDownloadPolicy {
  public static final long MAX_CAPTURE = 64L * 1024 * 1024;
  public static final int MAX_NAME = 100;

  private BrowserDownloadPolicy() {}

  /**
   * Whether the request may carry the source tab's cookie. {@code pageOrigin} is the canonical
   * origin of the tab's committed document, read when the user confirms the download.
   */
  public static boolean cookieAllowed(
      String downloadUrl, String pageOrigin, boolean sourceTabOpen) {
    if (!sourceTabOpen || pageOrigin == null)
      return false;
    String target = BrowserWebOrigin.of(downloadUrl);
    return target != null && target.equals(BrowserWebOrigin.of(pageOrigin));
  }

  /** A cookie header value is attached only when it is a bounded single line. */
  public static boolean cookieHeaderAcceptable(String cookie) {
    if (cookie == null || cookie.isEmpty() || cookie.length() >= 8192)
      return false;
    for (int i = 0; i < cookie.length(); i++)
      if (cookie.charAt(i) < 0x20 || cookie.charAt(i) == 0x7f)
        return false;
    return true;
  }

  /** The longest suffix after the last '.' that a long name keeps as its extension. */
  static final int MAX_EXTENSION = 16;

  /**
   * A display/file name of letters, digits, marks and {@code ._ -}, never hidden, at most {@link
   * #MAX_NAME}. Control and format characters (bidi overrides included) are removed; any other
   * character, path separators included, becomes {@code _}. A long name is cut in its stem so its
   * extension (up to {@link #MAX_EXTENSION} characters) survives.
   */
  public static String sanitizeName(String name) {
    String safe = (name == null ? "" : name)
                      .replaceAll("[\\p{Cc}\\p{Cf}]", "")
                      .replaceAll("[^\\p{L}\\p{N}\\p{M}._ -]", "_")
                      .replaceAll("^[. ]+", "")
                      .trim();
    if (safe.isEmpty())
      safe = "download";
    if (safe.length() <= MAX_NAME)
      return safe;
    int dot = safe.lastIndexOf('.');
    String extension =
        dot > 0 && safe.length() - dot - 1 <= MAX_EXTENSION ? safe.substring(dot) : "";
    int stem = MAX_NAME - extension.length();
    // Never split a surrogate pair.
    if (Character.isLowSurrogate(safe.charAt(stem)))
      stem--;
    return safe.substring(0, stem).trim() + extension;
  }

  public static boolean validMime(String mime) {
    return mime != null && mime.length() <= 200
        && mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+");
  }

  private static boolean isData(String raw) {
    return raw != null && raw.regionMatches(true, 0, "data:", 0, 5);
  }

  /** The declared media type of a {@code data:} URL, lower case, or null. */
  public static String dataMime(String raw) {
    if (!isData(raw))
      return null;
    int comma = raw.indexOf(',');
    if (comma < 5)
      return null;
    String type = raw.substring(5, comma).split(";", -1)[0].trim();
    return validMime(type) ? type.toLowerCase(Locale.ROOT) : null;
  }

  /** RFC 3986 percent-decoding to bytes; '+' stays '+', malformed escapes stay literal. */
  static byte[] percentDecode(String text) {
    ByteArrayOutputStream out = new ByteArrayOutputStream(text.length());
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    for (int i = 0; i < bytes.length; i++) {
      int b = bytes[i];
      if (b == '%' && i + 2 < bytes.length) {
        int hi = Character.digit(bytes[i + 1], 16), lo = Character.digit(bytes[i + 2], 16);
        if (hi >= 0 && lo >= 0) {
          out.write((hi << 4) | lo);
          i += 2;
          continue;
        }
      }
      out.write(b);
    }
    return out.toByteArray();
  }

  /**
   * The bytes of a {@code data:} URL (Android 26+). Throws {@link IllegalArgumentException} when it
   * is not a data URL, is malformed, or is larger than {@link #MAX_CAPTURE}.
   */
  public static byte[] decodeData(String raw) {
    if (!isData(raw))
      throw new IllegalArgumentException("not a data URL");
    int comma = raw.indexOf(',');
    int fragment = raw.indexOf('#');
    int end = fragment < 0 ? raw.length() : fragment;
    if (comma < 5 || comma >= end || end > MAX_CAPTURE * 4 / 3 + 1024)
      throw new IllegalArgumentException("invalid data URL");
    String metadata = raw.substring(5, comma).trim().toLowerCase(Locale.ROOT);
    boolean base64 = metadata.matches(".*; *base64");
    byte[] body = percentDecode(raw.substring(comma + 1, end));
    byte[] bytes;
    try {
      if (base64) {
        // Data URLs use forgiving base64: ignore ASCII whitespace, not arbitrary bytes.
        int length = 0;
        for (byte value : body) {
          if (value != 0x09 && value != 0x0a && value != 0x0c && value != 0x0d && value != 0x20)
            body[length++] = value;
        }
        bytes =
            Base64.getDecoder().decode(length == body.length ? body : Arrays.copyOf(body, length));
      } else
        bytes = body;
    } catch (IllegalArgumentException invalid) {
      throw new IllegalArgumentException("invalid base64");
    }
    if (bytes.length > MAX_CAPTURE)
      throw new IllegalArgumentException("too large");
    return bytes;
  }

  /**
   * One download list entry. {@code tab} is kept only for ephemeral-profile entries. An entry the
   * host transfers itself is {@code running} until it ends with the saved file's {@code uri} or as
   * {@code failed}; running entries are never persisted.
   */
  public static final class Entry {
    public final long id;
    public final String name, origin, tab, uri;
    public final boolean ephemeral, running, failed;

    public Entry(long id, String name, String origin, boolean ephemeral, String tab) {
      this(id, name, origin, ephemeral, tab, null, false, false);
    }

    public Entry(long id, String name, String origin, boolean ephemeral, String tab, String uri,
        boolean running, boolean failed) {
      if (id == 0)
        throw new IllegalArgumentException("id");
      if (ephemeral && (tab == null || tab.isEmpty()))
        throw new IllegalArgumentException("ephemeral entries need their tab");
      if (running && (failed || uri != null))
        throw new IllegalArgumentException("a running entry has no result yet");
      this.id = id;
      this.name = sanitizeName(name);
      this.origin = origin;
      this.ephemeral = ephemeral;
      this.tab = ephemeral ? tab : null;
      this.uri = uri;
      this.running = running;
      this.failed = failed;
    }

    /** The same entry while the host transfers it. */
    public Entry started() {
      return new Entry(id, name, origin, ephemeral, tab, null, true, false);
    }

    /** The same entry after the host saved it at {@code savedUri} (null when it failed). */
    public Entry finished(String savedUri) {
      return new Entry(id, name, origin, ephemeral, tab, savedUri, false, savedUri == null);
    }
  }

  /**
   * The browser's own download list. The host persists {@link #persistable()} (never ephemeral
   * entries) and calls {@link #restore} with what it persisted. Files already handed to the OS are
   * never deleted by this list.
   */
  public static final class History {
    public static final int MAX_ENTRIES = 50;
    private final LinkedHashMap<Long, Entry> entries = new LinkedHashMap<>();

    /**
     * Restores persisted entries; an ephemeral or running entry (written by an older build or
     * interrupted by process death) is dropped.
     */
    public void restore(List<Entry> persisted) {
      entries.clear();
      for (Entry entry : persisted) {
        if (!entry.ephemeral && !entry.running)
          entries.put(entry.id, entry);
      }
    }

    public Entry get(long id) {
      return entries.get(id);
    }

    /** Replaces an existing entry (a transfer that started or ended); false when it was removed. */
    public boolean replace(Entry entry) {
      Objects.requireNonNull(entry);
      if (!entries.containsKey(entry.id))
        return false;
      entries.put(entry.id, entry);
      return true;
    }

    /**
     * Removes every entry {@code match} accepts and returns them, so the host can stop their
     * running transfers.
     */
    public List<Entry> removeWhere(Predicate<Entry> match) {
      List<Entry> removed = new ArrayList<>();
      for (Iterator<Entry> it = entries.values().iterator(); it.hasNext();) {
        Entry entry = it.next();
        if (match.test(entry)) {
          it.remove();
          removed.add(entry);
        }
      }
      return removed;
    }

    public boolean full() {
      return entries.size() >= MAX_ENTRIES;
    }

    /** The oldest entry that a full list may retire: not running and not {@code busy}, or null. */
    private Entry retirable(Predicate<Entry> busy) {
      for (Entry entry : entries.values())
        if (!entry.running && !busy.test(entry))
          return entry;
      return null;
    }

    /** Whether {@link #add(Entry, Predicate)} can admit a new entry now. */
    public boolean hasRoom(Predicate<Entry> busy) {
      return !full() || retirable(busy) != null;
    }

    /** Adds an entry, retiring the oldest finished one when the list is full. */
    public boolean add(Entry entry) {
      return add(entry, finished -> false);
    }

    /**
     * Adds an entry. A full list retires its oldest entry that is neither running nor {@code busy}
     * (an OS transfer still in progress); only the row goes, never the saved file. False only when
     * every listed entry is still in progress.
     */
    public boolean add(Entry entry, Predicate<Entry> busy) {
      Objects.requireNonNull(entry);
      if (!entries.containsKey(entry.id) && full()) {
        Entry oldest = retirable(busy);
        if (oldest == null)
          return false;
        entries.remove(oldest.id);
      }
      entries.put(entry.id, entry);
      return true;
    }

    public boolean remove(long id) {
      return entries.remove(id) != null;
    }

    public List<Entry> all() {
      return Collections.unmodifiableList(new ArrayList<>(entries.values()));
    }

    /** What the host may write to durable storage: finished persistent-profile entries only. */
    public List<Entry> persistable() {
      List<Entry> out = new ArrayList<>();
      for (Entry entry : entries.values())
        if (!entry.ephemeral && !entry.running)
          out.add(entry);
      return out;
    }

    /** An ephemeral tab closed: forget its entries. Returns whether anything was removed. */
    public boolean forgetEphemeralTab(String tab) {
      return !removeWhere(entry -> entry.ephemeral && entry.tab.equals(tab)).isEmpty();
    }

    /** Clear browsing data: the whole list, both profiles. */
    public void clear() {
      entries.clear();
    }

    /** Clear data for this site: entries whose origin is the site or one of its subdomains. */
    public boolean clearSite(String site) {
      return !removeWhere(entry -> BrowserWebOrigin.withinSite(entry.origin, site)).isEmpty();
    }
  }
}
