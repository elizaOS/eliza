package ai.eliza.plugins.browsersurface;

import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * The persisted form of {@link BrowserSitePermissions}:
 * {@code {"https://host[:port]":{"camera":true,"microphone":false,"location":true}}}, oldest origin
 * first. The rules (persistent profile only, private tabs always ask, the 200-origin bound with
 * the oldest dropped first, clearing a site with its subdomains) stay in BrowserSitePermissions.
 * An origin or kind it does not recognize grants nothing and is dropped; a damaged record grants
 * nothing, so every site is asked again. Only org.json, no Android types: host-tested by javac.
 */
public final class BrowserSitePermissionRecord {
  private BrowserSitePermissionRecord() {}

  /** Decisions from the decrypted record, in stored order. Null or damaged reads as empty. */
  public static BrowserSitePermissions read(String json) {
    if (json == null) return BrowserSitePermissions.restore(null);
    try {
      return BrowserSitePermissions.restore(ordered(json));
    } catch (Exception damaged) {
      return BrowserSitePermissions.restore(null);
    }
  }

  /** org.json objects need not keep key order; the bound depends on it, so parse in order. */
  private static Map<String, Map<String, Boolean>> ordered(String json) throws Exception {
    JSONTokener tokens = new JSONTokener(json);
    if (tokens.nextClean() != '{') throw new IllegalArgumentException();
    LinkedHashMap<String, Map<String, Boolean>> sites = new LinkedHashMap<>();
    if (tokens.nextClean() == '}') return endOfRecord(tokens, sites);
    tokens.back();
    while (true) {
      Object origin = tokens.nextValue();
      if (!(origin instanceof String) || tokens.nextClean() != ':')
        throw new IllegalArgumentException();
      Object value = tokens.nextValue();
      if (value instanceof JSONObject) {
        JSONObject site = (JSONObject) value;
        LinkedHashMap<String, Boolean> decisions = new LinkedHashMap<>();
        for (String kind : BrowserSitePermissions.KINDS)
          if (site.opt(kind) instanceof Boolean) decisions.put(kind, (Boolean) site.get(kind));
        sites.remove(origin);
        sites.put((String) origin, decisions);
      }
      char next = tokens.nextClean();
      if (next == '}') return endOfRecord(tokens, sites);
      if (next != ',') throw new IllegalArgumentException();
    }
  }

  private static Map<String, Map<String, Boolean>> endOfRecord(
      JSONTokener tokens, Map<String, Map<String, Boolean>> sites) throws Exception {
    if (tokens.nextClean() != 0) throw new IllegalArgumentException();
    return sites;
  }

  /** The record to seal, oldest origin first. */
  public static String write(BrowserSitePermissions permissions) {
    StringBuilder out = new StringBuilder("{");
    for (Map.Entry<String, Map<String, Boolean>> site : permissions.snapshot().entrySet()) {
      if (out.length() > 1) out.append(',');
      out.append(JSONObject.quote(site.getKey()))
          .append(':')
          .append(new JSONObject(site.getValue()).toString());
    }
    return out.append('}').toString();
  }
}
