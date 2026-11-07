package ai.eliza.plugins.media;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What a permanent trash removal targets: every owned trashed item, or 1–20 named owned items
 * with the revisions the person reviewed. "Everything" is only ever an explicit intent. A missing,
 * null or non-list selection is refused rather than read as the whole trash. Pure Java (org.json
 * only) so JVM tests cover it.
 */
public final class TrashDeleteRequest {
  /** Same bound as {@code OwnedMediaLibrary.BATCH}. */
  public static final int MAX_NAMED = 20;

  private final Map<String, String> named;

  private TrashDeleteRequest(Map<String, String> named) {
    this.named = named;
  }

  /** Every owned trashed item. Callers reach this only from an explicit "empty trash" intent. */
  public static TrashDeleteRequest all() {
    return new TrashDeleteRequest(null);
  }

  /** 1–20 named owned items, each with its reviewed mutation revision; duplicates are refused. */
  public static TrashDeleteRequest named(JSONArray items) {
    if (items == null || items.length() < 1 || items.length() > MAX_NAMED)
      throw new IllegalArgumentException("Select deleted items again");
    Map<String, String> wanted = new LinkedHashMap<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      if (item == null) throw new IllegalArgumentException("Select deleted items again");
      Object key = item.opt("id"), version = item.opt("revision");
      if (!(key instanceof String)
          || !(version instanceof String)
          || !OwnedMediaSelection.isOwnedKey((String) key)
          || ((String) version).isEmpty()
          || ((String) version).length() > 160
          || wanted.put((String) key, (String) version) != null)
        throw new IllegalArgumentException("Select deleted items again");
    }
    return new TrashDeleteRequest(Collections.unmodifiableMap(wanted));
  }

  /**
   * Reads a bridge payload. {@code {"all": true}} with no {@code items} empties the trash; an
   * {@code items} list names the items. Anything else (no intent, both, {@code items: null}, a
   * non-list {@code items}, or {@code all} that is not exactly {@code true}) is refused.
   */
  public static TrashDeleteRequest fromPayload(JSONObject data) {
    if (data == null) throw new IllegalArgumentException("Select deleted items again");
    boolean hasItems = data.has("items");
    boolean hasAll = data.has("all");
    if (hasAll && hasItems) throw new IllegalArgumentException("Select deleted items again");
    if (hasAll) {
      if (!Boolean.TRUE.equals(data.opt("all")))
        throw new IllegalArgumentException("Select deleted items again");
      return all();
    }
    Object raw = data.opt("items");
    if (!(raw instanceof JSONArray)) throw new IllegalArgumentException("Select deleted items again");
    return named((JSONArray) raw);
  }

  public boolean isAll() {
    return named == null;
  }

  /** Named owned keys mapped to their reviewed revisions; empty for {@link #all()}. */
  public Map<String, String> items() {
    return named == null ? Collections.emptyMap() : named;
  }
}
