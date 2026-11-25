// spec/os/android/files/documentGrants.md, "The registry never holds more than 32 selections, and a new pick evicts the oldest"
package ai.eliza.plugins.media;

import java.util.LinkedHashMap;
import java.util.Map;

final class SelectionAdmission {
  static final int MAX = 32;

  private SelectionAdmission() {}

  static <U> void admit(Map<String, U> selected, Map<String, Integer> retained, String id, U uri,
      int flags, Runnable save) {
    Map<String, U> priorSelected = new LinkedHashMap<>(selected);
    Map<String, Integer> priorRetained = new LinkedHashMap<>(retained);
    selected.put(id, uri);
    if (flags != 0)
      retained.put(id, flags);
    while (selected.size() > MAX) {
      String oldest = selected.keySet().iterator().next();
      selected.remove(oldest);
      retained.remove(oldest);
    }
    try {
      save.run();
    } catch (RuntimeException error) {
      selected.clear();
      selected.putAll(priorSelected);
      retained.clear();
      retained.putAll(priorRetained);
      throw error;
    }
  }
}
