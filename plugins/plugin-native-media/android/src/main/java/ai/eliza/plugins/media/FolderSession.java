package ai.eliza.plugins.media;

import java.nio.charset.StandardCharsets;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Bounded capability session over one browsed folder tree. A renderer holds random entry ids,
 * never document locations; each entry remembers the folder it was listed in. When the session is
 * full, the least recently listed entries are evicted, but never the root, the folder being
 * listed, that folder's ancestors or its own listed children, so a listing never invalidates the
 * rows it returns. A folder too large for the bound stops listing instead of evicting its own rows.
 *
 * <p>Pure Java with no Android dependency. Not thread-safe: one serial caller (the host's folder
 * worker) owns a session.
 *
 * @param <U> the host's document location type (an Android {@code Uri} in {@link
 *     DocumentFolderTree}); only {@code equals} is used.
 */
public final class FolderSession<U> {
  /** Session capability bound. */
  public static final int LIMIT = 2048;
  /** Size an eviction pass shrinks the session to. */
  public static final int RETAIN = 1536;

  /** One listed document or folder. The location changes only on a confirmed rename. */
  public static final class Entry<U> {
    public final String id;
    /** The entry id of the folder this was listed in, or null for the root. */
    public final String parent;
    U location;
    long touched;

    Entry(String id, U location, String parent) {
      this.id = id;
      this.location = location;
      this.parent = parent;
    }

    public U location() {
      return location;
    }
  }

  private final int limit;
  private final int retain;
  private final Supplier<String> ids;
  private final Map<String, Entry<U>> entries = new HashMap<>();
  /** The same entries keyed by (location, parent), so a listing finds a relisted row directly. */
  private final Map<Map.Entry<U, String>, Entry<U>> listed = new HashMap<>();
  private String rootId;
  private long touch;

  public FolderSession() {
    this(LIMIT, RETAIN, () -> UUID.randomUUID().toString());
  }

  /** For tests: a smaller bound and deterministic ids. */
  FolderSession(int limit, int retain, Supplier<String> ids) {
    if (limit < 2 || retain < 1 || retain >= limit || ids == null)
      throw new IllegalArgumentException("Invalid folder session bound");
    this.limit = limit;
    this.retain = retain;
    this.ids = ids;
  }

  /** The root entry for the chosen tree's top document, created once per session. */
  public Entry<U> root(U location) {
    if (rootId == null) {
      Entry<U> root = new Entry<>(ids.get(), location, null);
      put(root);
      rootId = root.id;
    }
    return entries.get(rootId);
  }

  public String rootId() {
    return rootId;
  }

  /** The entry for an id this session issued, or null after eviction, removal or a reset. */
  public Entry<U> get(String id) {
    return id == null ? null : entries.get(id);
  }

  public int size() {
    return entries.size();
  }

  /** Marks a folder as listed now, so it is the last to be evicted. */
  public void touch(Entry<U> entry) {
    entry.touched = ++touch;
  }

  /** Forgets one entry after the provider confirmed it was deleted or moved away. */
  public void remove(String id) {
    Entry<U> entry = entries.remove(id);
    if (entry != null) listed.remove(key(entry.location, entry.parent), entry);
  }

  /** Records a provider-confirmed rename of a listed entry. */
  public void renamed(Entry<U> entry, U location) {
    listed.remove(key(entry.location, entry.parent), entry);
    entry.location = location;
    if (entries.get(entry.id) == entry) listed.put(key(location, entry.parent), entry);
  }

  /** Forgets every capability, for example when access to the tree was revoked or replaced. */
  public void clear() {
    entries.clear();
    listed.clear();
    rootId = null;
  }

  /**
   * The entry for a document listed in {@code parent}: the existing one when this location was
   * already listed there, otherwise a new capability. Throws IllegalStateException when the
   * session is full and nothing may be evicted.
   */
  public Entry<U> authorize(U location, String parent) {
    Entry<U> item = listed.get(key(location, parent));
    if (item != null) {
      item.touched = ++touch;
      return item;
    }
    Entry<U> folder = parent == null ? null : entries.get(parent);
    if (folder != null) evict(folder);
    else if (entries.size() >= limit) throw new IllegalStateException("Folder session limit");
    Entry<U> value = new Entry<>(ids.get(), location, parent);
    value.touched = ++touch;
    put(value);
    return value;
  }

  private void put(Entry<U> entry) {
    entries.put(entry.id, entry);
    listed.put(key(entry.location, entry.parent), entry);
  }

  private static <U> Map.Entry<U, String> key(U location, String parent) {
    return new AbstractMap.SimpleImmutableEntry<>(location, parent);
  }

  /** The folder, its ancestors and the root. */
  Set<String> chain(Entry<U> folder) {
    Set<String> keep = new HashSet<>();
    for (Entry<U> at = folder;
        at != null && keep.add(at.id);
        at = at.parent == null ? null : entries.get(at.parent))
      ;
    if (rootId != null) keep.add(rootId);
    return keep;
  }

  private void evict(Entry<U> folder) {
    if (entries.size() < limit) return;
    Set<String> keep = chain(folder);
    List<Entry<U>> candidates = new ArrayList<>();
    for (Entry<U> item : entries.values())
      if (!keep.contains(item.id) && !Objects.equals(item.parent, folder.id)) candidates.add(item);
    candidates.sort((a, b) -> Long.compare(a.touched, b.touched));
    for (Entry<U> item : candidates) {
      if (entries.size() <= retain) break;
      remove(item.id);
    }
    if (entries.size() >= limit) throw new IllegalStateException("Folder session limit");
  }

  /** {@link #cursorOffset}: the cursor names another folder (or no folder is listed). */
  public static final int OTHER_FOLDER = -1;
  /** {@link #cursorOffset}: the cursor is malformed, from an older build, or not positive. */
  public static final int MALFORMED = -2;

  /**
   * The provider offset a "Load more" cursor names for {@code folderId}, {@link #OTHER_FOLDER}
   * when it belongs to another folder, or {@link #MALFORMED}. Either refusal asks for a refresh.
   */
  public static int cursorOffset(String cursor, String folderId) {
    if (cursor == null || folderId == null) return OTHER_FOLDER;
    int last = cursor.lastIndexOf(':');
    int split = last < 1 ? -1 : cursor.lastIndexOf(':', last - 1);
    if (split < 0 || cursorLast(cursor) == null) return MALFORMED;
    if (split < 1 || !cursor.substring(0, split).equals(folderId)) return OTHER_FOLDER;
    try {
      int offset = Integer.parseInt(cursor.substring(split + 1, last));
      return offset < 1 ? MALFORMED : offset;
    } catch (NumberFormatException malformed) {
      return MALFORMED;
    }
  }

  /**
   * The provider document id of the last row the page before a "Load more" cursor showed, or null
   * when the cursor is malformed. The next page continues only while that row is still in place.
   */
  public static String cursorLast(String cursor) {
    int last = cursor == null ? -1 : cursor.lastIndexOf(':');
    if (last < 0 || last == cursor.length() - 1) return null;
    try {
      return new String(
          Base64.getUrlDecoder().decode(cursor.substring(last + 1)), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException malformed) {
      return null;
    }
  }

  /**
   * The revision a change must name: a listed row's name, type, size, modification time and
   * provider flags. Size and modification time are -1 when the provider does not report them.
   */
  public static String revision(String name, String mime, long size, long modified, long flags) {
    return name + "|" + mime + "|" + size + "|" + modified + "|" + flags;
  }

  /**
   * A "Load more" cursor for the next page of a folder: the folder, the number of rows shown and
   * the provider document id of the last one.
   */
  public static String cursor(String folderId, int shown, String lastDocumentId) {
    return folderId
        + ":"
        + shown
        + ":"
        + Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(lastDocumentId.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * A single new name inside a folder: 1-255 characters after trimming, not "." or "..", with no
   * path separator or control character. Throws IllegalArgumentException otherwise.
   */
  public static String childName(String raw) {
    String name = raw == null ? "" : raw.trim();
    if (name.isEmpty()
        || name.length() > 255
        || name.equals(".")
        || name.equals("..")
        || name.indexOf('/') >= 0
        || name.indexOf('\\') >= 0
        || name.chars().anyMatch(Character::isISOControl))
      throw new IllegalArgumentException("Invalid name");
    return name;
  }
}
