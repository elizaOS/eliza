// spec/os/browser/tabHost/storage.md, "A saved session keeps the first valid row of each tab and address"; spec/os/browser/tabHost/storage.md, "A visit time is kept only for a kept history address, as a positive whole number of milliseconds"
package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The persisted form of the normal-tab session: {@code history}, {@code tabs}, {@code cur} and,
 * when any is kept, {@code visitTimes} by history address. The rules for tabs and history stay in
 * {@link BrowserSessionPolicy}. Only org.json, no Android types: host-tested by javac.
 */
public final class BrowserSessionRecord {
  private static final double MAX_VISIT_MILLIS = 9_007_199_254_740_991d;

  private BrowserSessionRecord() {}

  /** Canonical restorable form with optional visit times on the retained history URLs. */
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
    JSONObject result = new JSONObject()
        .put("history", new JSONArray(saved.history))
        .put("tabs", rows)
        .put("cur", saved.current);
    JSONObject visitTimes = input.optJSONObject("visitTimes");
    if (visitTimes != null) {
      JSONObject retained = new JSONObject();
      for (String url : saved.history) {
        Object rawTime = visitTimes.opt(url);
        if (rawTime instanceof Number) {
          double time = ((Number) rawTime).doubleValue();
          if (time > 0 && time <= MAX_VISIT_MILLIS && time == Math.floor(time))
            retained.put(url, (long) time);
        }
      }
      if (retained.length() > 0) result.put("visitTimes", retained);
    }
    return result;
  }
}
