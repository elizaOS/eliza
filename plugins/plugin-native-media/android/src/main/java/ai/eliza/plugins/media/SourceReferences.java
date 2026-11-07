package ai.eliza.plugins.media;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reference counting for a saved item's linked source document. A reference {@code a1:<sha256>}
 * names a stored document URI the item can reopen while Android keeps its persisted read grant. A
 * grant stays while any reference names its URI, even after the picker selection that granted it is
 * forgotten or evicted; it is released when the last saved or restorable item that names it is
 * gone. A reference no item names yet (for example a content question whose answer may be saved
 * later) is kept for a grace period after it was last retained. No Android types: host-tested.
 */
public final class SourceReferences {
  private SourceReferences() {}
  /** Stored references. Pruning keeps the map from silently filling. */
  public static final int LIMIT = 128;
  /** Default grace for a reference no saved item names: three days, a Trash-like retention. */
  public static final long GRACE_MS = 3L * 24 * 60 * 60 * 1000;
  /** Longest document URI a reference stores. */
  public static final int URI_LIMIT = 4096;
  public static boolean valid(String reference) {
    return reference != null && reference.matches("a1:[a-f0-9]{64}");
  }
  /** The stable reference for one document URI. */
  public static String reference(String uri) throws Exception {
    if (uri == null || uri.isEmpty() || uri.length() > URI_LIMIT)
      throw new IllegalArgumentException("Invalid source document");
    return "a1:" + DocumentBytes.sha256(uri.getBytes(StandardCharsets.UTF_8));
  }
  /** True when any stored reference names this document URI. */
  public static boolean referenced(Map<String, ?> references, String uri) {
    if (uri == null)
      return false;
    for (Map.Entry<String, ?> entry : references.entrySet())
      if (valid(entry.getKey()) && uri.equals(entry.getValue()))
        return true;
    return false;
  }
  /**
   * Stored references whose retain time is missing, unreadable or ahead of now (a reference stored
   * before times were kept, or a clock moved backwards). The caller records now for them, so each
   * gets a full grace period instead of being pruned at once or held forever.
   */
  public static List<String> unseeded(
      Map<String, ?> references, Map<String, ?> retainedAt, long now) {
    List<String> seed = new ArrayList<>();
    for (String key : references.keySet()) {
      if (!valid(key))
        continue;
      Object retained = retainedAt.get(key);
      if (!(retained instanceof Long) || (Long) retained > now)
        seed.add(key);
    }
    return seed;
  }
  /** {@link #unreferenced(Map,Set,Map,long,long)} with the default {@link #GRACE_MS}. */
  public static List<String> unreferenced(
      Map<String, ?> references, Set<String> keep, Map<String, ?> retainedAt, long now) {
    return unreferenced(references, keep, retainedAt, now, GRACE_MS);
  }
  /**
   * Stored references no saved or restorable item names (keep) and that were last retained at least
   * grace ago. A reference without a usable retain time is kept (see unseeded). Entries that are
   * not a1: references are left for their owner.
   */
  public static List<String> unreferenced(Map<String, ?> references, Set<String> keep,
      Map<String, ?> retainedAt, long now, long grace) {
    if (grace < 0)
      throw new IllegalArgumentException("Invalid grace period");
    List<String> drop = new ArrayList<>();
    for (String key : references.keySet()) {
      if (!valid(key) || keep.contains(key))
        continue;
      Object retained = retainedAt.get(key);
      if (!(retained instanceof Long))
        continue;
      long at = (Long) retained;
      if (at > now || now - at < grace)
        continue;
      drop.add(key);
    }
    return drop;
  }
  /** Document URIs of the dropped references that no remaining reference names. */
  public static Set<String> orphaned(Map<String, ?> references, Collection<String> dropped) {
    Set<String> candidates = new LinkedHashSet<>();
    for (String key : dropped) {
      Object value = references.get(key);
      if (value instanceof String)
        candidates.add((String) value);
    }
    for (Map.Entry<String, ?> entry : references.entrySet())
      if (!dropped.contains(entry.getKey()) && valid(entry.getKey()))
        candidates.remove(entry.getValue());
    return candidates;
  }
}
