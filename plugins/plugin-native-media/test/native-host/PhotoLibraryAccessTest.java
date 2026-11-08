import ai.eliza.plugins.media.PhotoLibraryAccess;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** JVM checks for the Photos bridge rules: scope reporting, aliases, listings, bounds and changes. */
public final class PhotoLibraryAccessTest {
  private static int checks;
  private static void check(boolean value) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks);
  }
  private interface Failing {
    void run() throws Exception;
  }
  private static void rejects(Failing body) {
    checks++;
    try {
      body.run();
    } catch (IllegalArgumentException expected) {
      return;
    } catch (Exception other) {
      throw new AssertionError("Check " + checks + ": " + other);
    }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  private static JSONObject access(String scope, String images, String videos) throws Exception {
    return new JSONObject().put("scope", scope).put("images", images).put("videos", videos);
  }
  private static JSONArray items(String... pairs) throws Exception {
    JSONArray out = new JSONArray();
    for (int i = 0; i < pairs.length; i += 2)
      out.put(new JSONObject().put("id", pairs[i]).put("revision", pairs[i + 1]));
    return out;
  }

  public static void main(String[] args) throws Exception {
    // Aliases: the legacy permission only before Android 13; selected access only from 14.
    check(Arrays.equals(PhotoLibraryAccess.permissionAliases(29), new String[] {"libraryLegacy"}));
    check(Arrays.equals(PhotoLibraryAccess.permissionAliases(32), new String[] {"libraryLegacy"}));
    check(Arrays.equals(PhotoLibraryAccess.permissionAliases(33), new String[] {"libraryImages", "libraryVideos"}));
    check(Arrays.equals(PhotoLibraryAccess.permissionAliases(36),
        new String[] {"libraryImages", "libraryVideos", "librarySelected"}));
    for (int sdk = 29; sdk <= 36; sdk++)
      check(PhotoLibraryAccess.ALIASES.containsAll(Arrays.asList(PhotoLibraryAccess.permissionAliases(sdk))));

    // Scope: full, partial (one kind), Android 14 selected and denied are reported per kind.
    JSONObject full = PhotoLibraryAccess.scope(access("full", "full", "full"), 36, false, "v1", new JSONObject());
    check(full.getString("scope").equals("full") && full.getBoolean("images") && full.getBoolean("videos"));
    check(full.getBoolean("canSelectMore") && full.getBoolean("canEditOthers") && !full.getBoolean("locked"));
    check(full.getString("version").equals("v1"));
    JSONObject partial = PhotoLibraryAccess.scope(access("partial", "full", "denied"), 33, true, null, new JSONObject());
    check(partial.getString("scope").equals("partial") && partial.getBoolean("images") && !partial.getBoolean("videos"));
    check(partial.getString("videoAccess").equals("denied") && !partial.getBoolean("canSelectMore"));
    check(partial.getBoolean("locked") && partial.getString("version").isEmpty());
    JSONObject selected = PhotoLibraryAccess.scope(access("selected", "selected", "selected"), 34, false, "v", new JSONObject());
    check(!selected.getBoolean("images") && !selected.getBoolean("videos"));
    check(selected.getString("imageAccess").equals("selected") && selected.getBoolean("canSelectMore"));
    JSONObject old = PhotoLibraryAccess.scope(access("full", "full", "full"), 29, false, "v", new JSONObject());
    check(!old.getBoolean("canEditOthers"));
    check(PhotoLibraryAccess.readable(access("selected", "selected", "selected")));
    check(PhotoLibraryAccess.readable(access("partial", "full", "denied")));
    check(!PhotoLibraryAccess.readable(access("denied", "denied", "denied")));
    check(!PhotoLibraryAccess.readable(new JSONObject()));
    check(!PhotoLibraryAccess.readable(null));

    // Listings: the grid's albums map to catalog filters; unknown names are refused.
    check(Arrays.equals(PhotoLibraryAccess.permittedListing("", false), new String[] {"all", "all"}));
    check(Arrays.equals(PhotoLibraryAccess.permittedListing(null, false), new String[] {"all", "all"}));
    check(Arrays.equals(PhotoLibraryAccess.permittedListing("favorites", false), new String[] {"all", "favorites"}));
    check(Arrays.equals(PhotoLibraryAccess.permittedListing("videos", false), new String[] {"video", "all"}));
    check(Arrays.equals(PhotoLibraryAccess.permittedListing("", true), new String[] {"all", "trash"}));
    check(Arrays.equals(PhotoLibraryAccess.permittedListing("favorites", true), new String[] {"all", "trash"}));
    rejects(() -> PhotoLibraryAccess.permittedListing("custom:1", false));
    rejects(() -> PhotoLibraryAccess.permittedListing("everything", false));
    check(PhotoLibraryAccess.customAlbum("custom:abc") && !PhotoLibraryAccess.customAlbum("favorites"));

    // Page bounds.
    check(PhotoLibraryAccess.pageLimit(0) == 1 && PhotoLibraryAccess.pageLimit(-5) == 1);
    check(PhotoLibraryAccess.pageLimit(24) == 24 && PhotoLibraryAccess.pageLimit(1000) == 24);

    // Reviewed selections: 1..max items with string ids and revisions; never "everything".
    rejects(() -> PhotoLibraryAccess.reviewed(null, 20));
    rejects(() -> PhotoLibraryAccess.reviewed(new JSONArray(), 20));
    JSONArray many = new JSONArray();
    for (int i = 0; i < 21; i++) many.put(new JSONObject().put("id", "m:external:i:" + (i + 1)).put("revision", "r"));
    rejects(() -> PhotoLibraryAccess.reviewed(many, 20));
    rejects(() -> PhotoLibraryAccess.reviewed(new JSONArray().put("m:external:i:1"), 20));
    rejects(() -> PhotoLibraryAccess.reviewed(new JSONArray().put(new JSONObject().put("id", "m:a")), 20));
    rejects(() -> PhotoLibraryAccess.reviewed(new JSONArray().put(new JSONObject().put("id", 4).put("revision", "r")), 20));
    rejects(() -> PhotoLibraryAccess.reviewed(items("", "r"), 20));
    List<PhotoLibraryAccess.Reviewed> picked = PhotoLibraryAccess.reviewed(items("m:external:i:1", "a", "12", "b"), 20);
    check(PhotoLibraryAccess.ids(picked).equals(List.of("m:external:i:1", "12")));
    check(PhotoLibraryAccess.revisions(picked).equals(List.of("a", "b")));
    check(PhotoLibraryAccess.anyPermitted(picked));
    check(!PhotoLibraryAccess.anyPermitted(PhotoLibraryAccess.reviewed(items("12", "b", "v:13", "c"), 20)));
    // A mixed batch: library and owned items change in separate parts, then report as one result.
    List<PhotoLibraryAccess.Reviewed> mixed =
        PhotoLibraryAccess.reviewed(items("12", "a", "m:external:i:1", "b", "v:13", "c"), 20);
    check(PhotoLibraryAccess.ids(PhotoLibraryAccess.only(mixed, true)).equals(List.of("m:external:i:1")));
    check(PhotoLibraryAccess.ids(PhotoLibraryAccess.only(mixed, false)).equals(List.of("12", "v:13")));
    JSONArray ownItems = PhotoLibraryAccess.items(PhotoLibraryAccess.only(mixed, false));
    check(ownItems.length() == 2 && ownItems.getJSONObject(1).getString("id").equals("v:13")
        && ownItems.getJSONObject(1).getString("revision").equals("c"));
    JSONObject changed = new JSONObject().put("status", "changed");
    JSONArray library = new JSONArray().put(
        new JSONObject().put("id", "m:external:i:1").put("status", "changed").put("item", changed));
    JSONArray own = new JSONArray()
        .put(new JSONObject().put("id", "12").put("status", "changed").put("item", changed))
        .put(new JSONObject().put("id", "v:13").put("status", "changed").put("item", changed));
    JSONObject all = PhotoLibraryAccess.merged(mixed, library, own);
    check(all.getString("status").equals("complete"));
    JSONArray outcomes = all.getJSONArray("outcomes");
    check(outcomes.length() == 3 && outcomes.getJSONObject(0).getString("id").equals("12")
        && outcomes.getJSONObject(1).getString("id").equals("m:external:i:1")
        && outcomes.getJSONObject(2).getString("id").equals("v:13"));
    own.getJSONObject(1).remove("item");
    own.getJSONObject(1).put("status", "stale");
    JSONObject part = PhotoLibraryAccess.merged(mixed, library, own);
    check(part.getString("status").equals("partial")
        && part.getJSONArray("outcomes").getJSONObject(2).getString("status").equals("stale"));
    // An owned change that failed outright reports its items unverified, not missing.
    JSONObject lost = PhotoLibraryAccess.merged(mixed, library, new JSONArray());
    check(lost.getString("status").equals("partial")
        && lost.getJSONArray("outcomes").getJSONObject(0).getString("status").equals("unverified")
        && lost.getJSONArray("outcomes").getJSONObject(1).has("item"));

    // Changes: Photos batches and agent album changes; permanent deletion is never an agent change.
    check(Arrays.equals(PhotoLibraryAccess.batchChange("favorite"), new boolean[] {true, true}));
    check(Arrays.equals(PhotoLibraryAccess.batchChange("trash"), new boolean[] {false, true}));
    check(Arrays.equals(PhotoLibraryAccess.batchChange("restore"), new boolean[] {false, false}));
    rejects(() -> PhotoLibraryAccess.batchChange("delete"));
    rejects(() -> PhotoLibraryAccess.batchChange(null));
    check(Arrays.equals(PhotoLibraryAccess.agentChange("favorite"), new boolean[] {true, true}));
    check(Arrays.equals(PhotoLibraryAccess.agentChange("unfavorite"), new boolean[] {true, false}));
    check(Arrays.equals(PhotoLibraryAccess.agentChange("trash"), new boolean[] {false, true}));
    check(PhotoLibraryAccess.agentChange("delete") == null && PhotoLibraryAccess.agentChange("restore") == null);
    check(PhotoLibraryAccess.agentChange(null) == null);
    System.out.println(checks + " photo library access checks passed");
  }
}
