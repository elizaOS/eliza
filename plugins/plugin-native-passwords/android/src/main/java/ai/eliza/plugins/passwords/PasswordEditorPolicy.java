package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** Plain-Java admission and binding rules for the native editor and bridge saves (no Android framework). */
public final class PasswordEditorPolicy {
  private PasswordEditorPolicy() {}

  public static final class Request {
    public final String entryId; public final long expectedRevision;
    Request(String entryId, long expectedRevision) { this.entryId = entryId; this.expectedRevision = expectedRevision; }
    public boolean editing() { return entryId != null; }
  }
  public static final Request CREATE = new Request(null, 0);

  /** An empty call creates. An edit names both an entry and its revision. Any other key is a draft field. */
  public static Request admit(Iterator<String> keys, Object entryId, Object expectedRevision) {
    int count = 0;
    for (; keys.hasNext(); count++) {
      String key = keys.next();
      if (!"entryId".equals(key) && !"expectedRevision".equals(key)) throw new IllegalArgumentException("Unknown editor field");
    }
    if (count == 0) return CREATE;
    if (!(entryId instanceof String) || ((String) entryId).isEmpty() || ((String) entryId).length() > 128) throw new IllegalArgumentException("Invalid entry");
    if (!(expectedRevision instanceof Integer || expectedRevision instanceof Long) || ((Number) expectedRevision).longValue() < 0) throw new IllegalArgumentException("Invalid revision");
    return new Request((String) entryId, ((Number) expectedRevision).longValue());
  }

  /**
   * A bridge save that carries no password and no {@code generate}, and names an existing entry.
   * Hosts that keep passwords out of the bridge admit only these.
   */
  public static boolean metadataOnly(Iterator<String> keys, Object id) {
    while (keys.hasNext()) {
      String key = keys.next();
      if ("password".equals(key) || "generate".equals(key)) return false;
    }
    return id instanceof String && !((String) id).isEmpty();
  }

  /** The web binding the editor's one website field shows, or empty. */
  public static String firstWeb(List<String> stored) {
    for (String facet : stored) if (PasswordFacets.isWeb(facet)) return facet;
    return "";
  }

  /** Replaces the first web binding with {@code origin} (null removes it). Every other binding stays. */
  public static List<String> editedBindings(List<String> stored, String origin) {
    List<String> edited = new ArrayList<>();
    boolean replaced = false;
    for (String facet : stored) {
      if (!replaced && PasswordFacets.isWeb(facet)) {
        replaced = true;
        if (origin != null) edited.add(origin);
      } else edited.add(facet);
    }
    if (!replaced && origin != null) edited.add(origin);
    return edited;
  }
}
