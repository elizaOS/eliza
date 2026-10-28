package ai.eliza.plugins.browsersurface;

import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The persistent normal-tab profile's saved state: browsing history, the restorable tab list
 * ({@link BrowserSessionPolicy}) and website permission decisions ({@link BrowserSitePermissions},
 * stored as {@link BrowserSitePermissionRecord}). Private tabs never reach this store. Addresses
 * and origins reveal visited sites, so both records are sealed by the host's
 * {@link BrowserSealedText}; the host chooses the preferences file and key so installed data keeps
 * its name. Nothing here holds page content, form data, cookies or credentials.
 *
 * <p>A damaged session record is reported; a damaged permission record grants nothing and every
 * site is asked again.
 */
public final class BrowserSessionStore {
  public static final String SESSION_KEY = "sealed";
  public static final String PERMISSIONS_KEY = "permissions";
  public static final int MAX_PERMISSION_ORIGINS = BrowserSitePermissions.MAX_ORIGINS;
  public static final Set<String> PERMISSION_KINDS = BrowserSitePermissions.KINDS;
  private final SharedPreferences preferences;
  private final BrowserSealedText sealer;

  public BrowserSessionStore(SharedPreferences preferences, BrowserSealedText sealer) {
    this.preferences = preferences;
    this.sealer = sealer;
  }

  /** Canonical restorable form ({@code history}, {@code tabs}, {@code cur}). Invalid rows are dropped. */
  public static JSONObject normalize(JSONObject input) throws Exception {
    List<String> history = new ArrayList<>();
    List<BrowserSessionPolicy.Tab> tabs = new ArrayList<>();
    JSONArray rawHistory = input.optJSONArray("history"), rawTabs = input.optJSONArray("tabs");
    if (rawHistory != null)
      for (int i = 0; i < rawHistory.length(); i++) history.add(rawHistory.optString(i, null));
    if (rawTabs != null)
      for (int i = 0; i < rawTabs.length(); i++) {
        JSONObject tab = rawTabs.optJSONObject(i);
        if (tab == null) continue;
        tabs.add(new BrowserSessionPolicy.Tab(tab.optString("id", null), tab.optString("url", null),
            tab.optString("title", ""), tab.optBoolean("private", false)));
      }
    BrowserSessionPolicy.Snapshot saved =
        BrowserSessionPolicy.restore(tabs, history, input.optString("cur", ""));
    JSONArray rows = new JSONArray();
    for (BrowserSessionPolicy.Tab tab : saved.tabs)
      rows.put(new JSONObject().put("id", tab.id).put("url", tab.url).put("title", tab.title));
    return new JSONObject()
        .put("history", new JSONArray(saved.history))
        .put("tabs", rows)
        .put("cur", saved.current);
  }

  public synchronized JSONObject read() throws Exception {
    String packed = preferences.getString(SESSION_KEY, null);
    if (packed == null) return normalize(new JSONObject());
    return normalize(new JSONObject(sealer.open(packed)));
  }

  /** Stores the canonical form of {@code state} and returns it. */
  public synchronized JSONObject write(JSONObject state) throws Exception {
    JSONObject canonical = normalize(state);
    if (!preferences.edit().putString(SESSION_KEY, sealer.seal(canonical.toString())).commit())
      throw new IllegalStateException();
    return canonical;
  }

  public synchronized void clear() {
    if (!preferences.edit().remove(SESSION_KEY).commit()) throw new IllegalStateException();
  }

  public static boolean validOrigin(String origin) {
    return origin != null && origin.length() <= 300 && origin.equals(BrowserWebOrigin.of(origin));
  }

  private BrowserSitePermissions decisions() {
    String packed = preferences.getString(PERMISSIONS_KEY, null);
    if (packed == null) return BrowserSitePermissionRecord.read(null);
    try {
      return BrowserSitePermissionRecord.read(sealer.open(packed));
    } catch (Exception damaged) {
      return BrowserSitePermissionRecord.read(null);
    }
  }

  private void save(BrowserSitePermissions decisions) throws Exception {
    String bounded = BrowserSitePermissionRecord.write(decisions);
    if (!preferences.edit().putString(PERMISSIONS_KEY, sealer.seal(bounded)).commit())
      throw new IllegalStateException();
  }

  /** Stored decision for the persistent profile, or null when the site must be asked. */
  public synchronized Boolean permission(String origin, String kind) {
    return decisions().decision(origin, kind, false);
  }

  public synchronized void setPermission(String origin, String kind, boolean allowed)
      throws Exception {
    if (!validOrigin(origin) || !PERMISSION_KINDS.contains(kind))
      throw new IllegalArgumentException();
    BrowserSitePermissions all = decisions();
    if (!all.record(origin, kind, allowed, false)) throw new IllegalArgumentException();
    save(all);
  }

  public synchronized void clearPermissions() {
    if (!preferences.edit().remove(PERMISSIONS_KEY).commit()) throw new IllegalStateException();
  }

  /** Removes decisions for a registrable domain and its subdomains (Clear data for this site). */
  public synchronized void clearPermissionsForSite(String site) throws Exception {
    if (site == null || site.isEmpty()) return;
    BrowserSitePermissions all = decisions();
    if (all.clearSite(site)) save(all);
  }
}
