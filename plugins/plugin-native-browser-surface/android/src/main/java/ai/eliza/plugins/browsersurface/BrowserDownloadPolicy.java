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

  /** A display/file name made of portable characters, never hidden, at most {@link #MAX_NAME}. */
  public static String sanitizeName(String name) {
    String safe = (name == null ? "" : name)
                      .replaceAll("[^A-Za-z0-9._ -]", "_")
                      .replaceAll("^[. ]+", "")
                      .trim();
    if (safe.isEmpty())
      safe = "download";
    return safe.length() > MAX_NAME ? safe.substring(0, MAX_NAME) : safe;
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

  /** One download list entry. {@code tab} is kept only for ephemeral-profile entries. */
  public static final class Entry {
    public final long id;
    public final String name, origin, tab;
    public final boolean ephemeral;

    public Entry(long id, String name, String origin, boolean ephemeral, String tab) {
      if (id == 0)
        throw new IllegalArgumentException("id");
      if (ephemeral && (tab == null || tab.isEmpty()))
        throw new IllegalArgumentException("ephemeral entries need their tab");
      this.id = id;
      this.name = sanitizeName(name);
      this.origin = origin;
      this.ephemeral = ephemeral;
      this.tab = ephemeral ? tab : null;
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

    /** Restores persisted entries; any ephemeral entry (written by an older build) is dropped. */
    public void restore(List<Entry> persisted) {
      entries.clear();
      for (Entry entry : persisted) {
        if (!entry.ephemeral)
          entries.put(entry.id, entry);
      }
    }

    public boolean full() {
      return entries.size() >= MAX_ENTRIES;
    }

    /** Adds an entry; false when the list is full (the host asks the user to remove one). */
    public boolean add(Entry entry) {
      Objects.requireNonNull(entry);
      if (!entries.containsKey(entry.id) && full())
        return false;
      entries.put(entry.id, entry);
      return true;
    }

    public boolean remove(long id) {
      return entries.remove(id) != null;
    }

    public List<Entry> all() {
      return Collections.unmodifiableList(new ArrayList<>(entries.values()));
    }

    /** What the host may write to durable storage: persistent-profile entries only. */
    public List<Entry> persistable() {
      List<Entry> out = new ArrayList<>();
      for (Entry entry : entries.values())
        if (!entry.ephemeral)
          out.add(entry);
      return out;
    }

    /** An ephemeral tab closed: forget its entries. Returns whether anything was removed. */
    public boolean forgetEphemeralTab(String tab) {
      boolean changed = false;
      for (Iterator<Entry> it = entries.values().iterator(); it.hasNext();) {
        Entry entry = it.next();
        if (entry.ephemeral && entry.tab.equals(tab)) {
          it.remove();
          changed = true;
        }
      }
      return changed;
    }

    /** Clear browsing data: the whole list, both profiles. */
    public void clear() {
      entries.clear();
    }

    /** Clear data for this site: entries whose origin is the site or one of its subdomains. */
    public boolean clearSite(String site) {
      boolean changed = false;
      for (Iterator<Entry> it = entries.values().iterator(); it.hasNext();) {
        if (BrowserWebOrigin.withinSite(it.next().origin, site)) {
          it.remove();
          changed = true;
        }
      }
      return changed;
    }
  }
}
