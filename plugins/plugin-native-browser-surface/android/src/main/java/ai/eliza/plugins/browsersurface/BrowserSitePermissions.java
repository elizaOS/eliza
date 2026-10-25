package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Per-origin website permission decisions (camera, microphone, location) for a browser surface.
 *
 * <p>Decisions exist only for the persistent profile. An ephemeral (private) tab never reads or
 * records one, so every private request is asked again and leaves nothing behind. The host shows
 * an origin-labelled Allow/Deny prompt, chains it to the OS runtime permission, and stores {@link
 * #snapshot()} in its own sealed storage (origins reveal visited sites). Clearing browsing data or
 * a site revokes the matching decisions. Bounded to {@link #MAX_ORIGINS}, oldest origin first.
 *
 * <p>Pure JVM; no Android types.
 */
public final class BrowserSitePermissions {
  public static final int MAX_ORIGINS = 200;
  public static final Set<String> KINDS =
      Collections.unmodifiableSet(new HashSet<>(Arrays.asList("camera", "microphone", "location")));
  private final LinkedHashMap<String, LinkedHashMap<String, Boolean>> decisions =
      new LinkedHashMap<>();

  /** Restores a snapshot; invalid origins or kinds are dropped (they grant nothing). */
  public static BrowserSitePermissions restore(Map<String, Map<String, Boolean>> snapshot) {
    BrowserSitePermissions permissions = new BrowserSitePermissions();
    if (snapshot == null)
      return permissions;
    for (Map.Entry<String, Map<String, Boolean>> site : snapshot.entrySet()) {
      String origin = BrowserWebOrigin.of(site.getKey());
      if (origin == null || !origin.equals(site.getKey()) || site.getValue() == null)
        continue;
      for (Map.Entry<String, Boolean> decision : site.getValue().entrySet())
        if (KINDS.contains(decision.getKey()) && decision.getValue() != null)
          permissions.put(origin, decision.getKey(), decision.getValue());
    }
    return permissions;
  }

  private void put(String origin, String kind, boolean allowed) {
    LinkedHashMap<String, Boolean> site = decisions.remove(origin);
    if (site == null)
      site = new LinkedHashMap<>();
    site.put(kind, allowed);
    while (decisions.size() >= MAX_ORIGINS) {
      Iterator<String> oldest = decisions.keySet().iterator();
      oldest.next();
      oldest.remove();
    }
    decisions.put(origin, site);
  }

  /** The stored decision, or null when the user must be asked (always null when ephemeral). */
  public Boolean decision(String pageUrl, String kind, boolean ephemeral) {
    if (ephemeral || !KINDS.contains(kind))
      return null;
    String origin = BrowserWebOrigin.of(pageUrl);
    Map<String, Boolean> site = origin == null ? null : decisions.get(origin);
    return site == null ? null : site.get(kind);
  }

  /**
   * Records a user decision for the persistent profile. Returns false, storing nothing, for an
   * ephemeral tab, an unknown kind or an address without a web origin.
   */
  public boolean record(String pageUrl, String kind, boolean allowed, boolean ephemeral) {
    String origin = BrowserWebOrigin.of(pageUrl);
    if (ephemeral || origin == null || !KINDS.contains(kind))
      return false;
    put(origin, kind, allowed);
    return true;
  }

  /** Clear data for this site: revokes decisions for the site and its subdomains. */
  public boolean clearSite(String site) {
    boolean changed = false;
    for (Iterator<String> it = decisions.keySet().iterator(); it.hasNext();) {
      if (BrowserWebOrigin.withinSite(it.next(), site)) {
        it.remove();
        changed = true;
      }
    }
    return changed;
  }

  public void clear() {
    decisions.clear();
  }

  public List<String> origins() {
    return Collections.unmodifiableList(new ArrayList<>(decisions.keySet()));
  }

  /** Oldest origin first, for the host's sealed storage. */
  public Map<String, Map<String, Boolean>> snapshot() {
    LinkedHashMap<String, Map<String, Boolean>> out = new LinkedHashMap<>();
    for (Map.Entry<String, LinkedHashMap<String, Boolean>> site : decisions.entrySet())
      out.put(site.getKey(), Collections.unmodifiableMap(new LinkedHashMap<>(site.getValue())));
    return Collections.unmodifiableMap(out);
  }
}
