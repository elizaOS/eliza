package ai.eliza.plugins.media;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The bridge rules the Photos plugins ({@link PhotosPlugin}, {@link DeviceLibraryPlugin}) apply
 * before they reach the catalog, the owned library or a review: which Android permission aliases an
 * explicit access request names on each API level, how a granted scope is reported (full, partial,
 * Android 14 selected or denied, per images and videos), which album a listing reads, page and
 * selection bounds, and how a change operation maps to a favorite or Recently deleted review.
 * Nothing here reads media or decides access: the catalog's own fences do. Pure Java (org.json
 * only) so JVM tests cover it.
 */
public final class PhotoLibraryAccess {
  /** Android 14: READ_MEDIA_VISUAL_USER_SELECTED and "select more". */
  public static final int SELECTED_SDK = 34;
  /** Android 13: READ_MEDIA_IMAGES / READ_MEDIA_VIDEO replace READ_EXTERNAL_STORAGE. */
  public static final int MEDIA_PERMISSIONS_SDK = 33;
  /** Android 11: MediaStore trash, favorites and write requests for other apps' media. */
  public static final int TRASH_SDK = 30;
  /** The agent album's page bound; the same as {@code OwnedMediaLibrary.PAGE}. */
  public static final int PAGE = 24;
  /** Validation reads at most this many named items in one call. */
  public static final int VALIDATE = 200;
  /** Reviewed changes, shares and permanent removals name at most this many items. */
  public static final int REVIEWED = 20;

  private PhotoLibraryAccess() {}

  /**
   * The permission aliases a host plugin declares ({@code libraryLegacy}, {@code libraryImages},
   * {@code libraryVideos}, {@code librarySelected}) that an explicit access request names on
   * {@code sdk}. The obsolete legacy permission is never asked for together with the media grants.
   */
  public static String[] permissionAliases(int sdk) {
    if (sdk >= SELECTED_SDK)
      return new String[] {"libraryImages", "libraryVideos", "librarySelected"};
    if (sdk >= MEDIA_PERMISSIONS_SDK) return new String[] {"libraryImages", "libraryVideos"};
    return new String[] {"libraryLegacy"};
  }

  /** Every alias a host plugin must declare for {@link #permissionAliases(int)} on any level. */
  public static final List<String> ALIASES =
      List.of("libraryLegacy", "libraryImages", "libraryVideos", "librarySelected");

  /** Whether the catalog's {@code access()} answer grants any read at all. */
  public static boolean readable(JSONObject access) {
    return access != null && !"denied".equals(access.optString("scope", "denied"));
  }

  /**
   * Writes the agent album's scope answer into {@code out}: the catalog's overall scope and the
   * per-kind access ({@code full}, {@code selected} or {@code denied}), whether each kind is fully
   * granted, whether Android can offer "select more" (14+) and edits to other apps' media (11+),
   * whether the profile is locked and the catalog's cursor identity.
   */
  public static JSONObject scope(JSONObject access, int sdk, boolean locked, String version,
      JSONObject out) throws JSONException {
    String images = access.optString("images", "denied"), videos = access.optString("videos", "denied");
    out.put("scope", access.optString("scope", "denied"));
    out.put("imageAccess", images);
    out.put("videoAccess", videos);
    out.put("images", "full".equals(images));
    out.put("videos", "full".equals(videos));
    out.put("canSelectMore", sdk >= SELECTED_SDK);
    out.put("canEditOthers", sdk >= TRASH_SDK);
    out.put("locked", locked);
    out.put("version", version == null ? "" : version);
    return out;
  }

  /** A page size request clamped to 1..{@link #PAGE}. */
  public static int pageLimit(int requested) {
    return Math.min(PAGE, Math.max(1, requested));
  }

  /**
   * Which permitted listing the Photos grid's {@code album} parameter reads, as
   * {@code {kind, filter}}: the whole library, favorites, videos, or Recently deleted. A custom
   * album ({@code custom:<id>}) is the host album store's, not a catalog listing; any other name is
   * refused.
   */
  public static String[] permittedListing(String album, boolean trashed) {
    String name = album == null ? "" : album;
    if (!name.isEmpty() && !name.equals("favorites") && !name.equals("videos"))
      throw new IllegalArgumentException("Unknown album");
    return new String[] {
      name.equals("videos") ? "video" : "all",
      trashed ? "trash" : name.equals("favorites") ? "favorites" : "all"
    };
  }

  /** Whether {@code album} names a custom album; its id follows the prefix. */
  public static boolean customAlbum(String album) {
    return album != null && album.startsWith("custom:");
  }

  /** One reviewed item: a catalog or owned key and the revision the person saw. */
  public static final class Reviewed {
    public final String id, revision;
    Reviewed(String id, String revision) {
      this.id = id;
      this.revision = revision;
    }
  }

  /**
   * 1..{@code max} items, each with a string {@code id} and {@code revision}. Missing, null and
   * non-list selections are refused rather than read as "everything".
   */
  public static List<Reviewed> reviewed(JSONArray items, int max) {
    if (items == null || items.length() < 1 || items.length() > max)
      throw new IllegalArgumentException("Select 1-" + max + " items again");
    List<Reviewed> out = new ArrayList<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      Object id = item == null ? null : item.opt("id");
      Object revision = item == null ? null : item.opt("revision");
      if (!(id instanceof String) || !(revision instanceof String) || ((String) id).isEmpty())
        throw new IllegalArgumentException("Select 1-" + max + " items again");
      out.add(new Reviewed((String) id, (String) revision));
    }
    return out;
  }

  /** The ids of a {@link #reviewed} selection, in order. */
  public static List<String> ids(List<Reviewed> items) {
    List<String> out = new ArrayList<>();
    for (Reviewed item : items) out.add(item.id);
    return out;
  }

  /** The revisions of a {@link #reviewed} selection, in order. */
  public static List<String> revisions(List<Reviewed> items) {
    List<String> out = new ArrayList<>();
    for (Reviewed item : items) out.add(item.revision);
    return out;
  }

  /** Whether any item names a permitted catalog row ({@code m:}) rather than an owned item. */
  public static boolean anyPermitted(List<Reviewed> items) {
    for (Reviewed item : items) if (permitted(item.id)) return true;
    return false;
  }

  /** Whether {@code id} names a permitted catalog row. */
  public static boolean permitted(String id) {
    return id != null && id.startsWith("m:");
  }

  /**
   * A Photos batch operation ({@code favorite}, {@code trash}, {@code restore}) as
   * {@code {favorite, desired}} for a permitted review: favorite sets the favorite flag, trash moves
   * to Recently deleted and restore takes it back out.
   */
  public static boolean[] batchChange(String operation) {
    switch (operation == null ? "" : operation) {
      case "favorite":
        return new boolean[] {true, true};
      case "trash":
        return new boolean[] {false, true};
      case "restore":
        return new boolean[] {false, false};
      default:
        throw new IllegalArgumentException("Unknown operation");
    }
  }

  /**
   * An agent album change ({@code favorite}, {@code unfavorite}, {@code trash}) as
   * {@code {favorite, desired}}, or null for anything else: permanent deletion is never an agent
   * album change and stays in the system photos app.
   */
  public static boolean[] agentChange(String operation) {
    switch (operation == null ? "" : operation) {
      case "favorite":
        return new boolean[] {true, true};
      case "unfavorite":
        return new boolean[] {true, false};
      case "trash":
        return new boolean[] {false, true};
      default:
        return null;
    }
  }
}
