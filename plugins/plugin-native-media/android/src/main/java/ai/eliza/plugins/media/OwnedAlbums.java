package ai.eliza.plugins.media;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Device-local custom albums over owned items ({@link OwnedMediaLibrary}) and, when granted,
 * permitted library items ({@link PermittedMediaCatalog}). An album stores member names and the
 * identity each had when added, never bytes or URIs; a member whose identity changed, or whose
 * access was revoked, is withheld from listings but its membership is kept. Every change names the
 * album revision the renderer listed, and every listing holds the permitted catalog's fence.
 *
 * <p>Albums live in one preference file, {@code <namespace>-owned-albums}, so installed albums
 * keep resolving when a host adopts this class. At most 24 albums of 200 members each. Owned
 * albums need Android 11 or later. Calls block; run them off the main thread.
 */
public final class OwnedAlbums {
  public static final int MAX_ALBUMS = 24;
  public static final int MAX_MEMBERS = 200;
  private static final Object LOCK = new Object();

  private final SharedPreferences store;
  private final OwnedMediaLibrary owned;
  private final PermittedMediaCatalog permitted;

  public OwnedAlbums(
      Context context,
      OwnedMediaConfig config,
      OwnedMediaLibrary owned,
      PermittedMediaCatalog permitted) {
    this.store =
        context.getApplicationContext().getSharedPreferences(config.preferences("owned-albums"), 0);
    this.owned = owned;
    this.permitted = permitted;
  }

  private static void requireSupported() {
    if (Build.VERSION.SDK_INT < 30)
      throw new UnsupportedOperationException("Owned albums require Android 11 or later");
  }

  private JSONArray data() throws Exception {
    return new JSONArray(store.getString("albums", "[]"));
  }

  private static JSONObject byId(JSONArray albums, String id) throws Exception {
    for (int i = 0; i < albums.length(); i++)
      if (albums.getJSONObject(i).getString("id").equals(id)) return albums.getJSONObject(i);
    throw new IllegalArgumentException("Album is no longer available");
  }

  private static boolean isPermitted(String key) {
    return key.startsWith("m:");
  }

  private JSArray ownedRows(JSONObject album, boolean previews, long before, int limit)
      throws Exception {
    JSONArray members = album.getJSONArray("members");
    Map<String, String> allowed = new HashMap<>();
    for (int i = 0; i < members.length(); i++) {
      JSONObject member = members.getJSONObject(i);
      String key = member.getString("id");
      if (!isPermitted(key)) allowed.put(key, member.getString("identity"));
    }
    return owned.members(allowed, previews, before, limit);
  }

  /** Metadata-only permitted members, read in one batched query per volume and type. */
  private JSArray permittedRows(JSONObject album, int offset, int limit) throws Exception {
    JSONArray members = album.getJSONArray("members");
    List<String[]> wanted = new ArrayList<>();
    List<Integer> offsets = new ArrayList<>();
    for (int i = offset; i < members.length(); i++) {
      JSONObject member = members.getJSONObject(i);
      String key = member.getString("id");
      if (!isPermitted(key)) continue;
      wanted.add(new String[] {key, member.getString("identity")});
      offsets.add(i + 1);
    }
    Map<String, JSObject> found = permitted.albumItems(wanted);
    JSArray result = new JSArray();
    // Retain membership, withhold inaccessible or changed media.
    for (int i = 0; i < wanted.size() && result.length() < limit; i++) {
      JSObject row = found.get(wanted.get(i)[0]);
      if (row == null) continue;
      row.put("albumOffset", offsets.get(i));
      result.put(row);
    }
    return result;
  }

  private static boolean hasPermitted(JSONObject album) throws Exception {
    JSONArray members = album.getJSONArray("members");
    for (int i = 0; i < members.length(); i++)
      if (isPermitted(members.getJSONObject(i).getString("id"))) return true;
    return false;
  }

  /** Every album with its visible member count and member names. */
  public JSObject albums() throws Exception {
    requireSupported();
    PermittedMediaCatalog.Fence fence = permitted.fence();
    JSONArray albums = data();
    JSArray result = new JSArray();
    for (int i = 0; i < albums.length(); i++) {
      JSONObject album = albums.getJSONObject(i);
      JSObject row = new JSObject();
      row.put("id", album.getString("id"));
      row.put("name", album.getString("name"));
      row.put("revision", album.getString("revision"));
      JSArray active = ownedRows(album, false, Long.MAX_VALUE, MAX_MEMBERS);
      JSArray full = permittedRows(album, 0, MAX_MEMBERS);
      for (int j = 0; j < full.length(); j++) active.put(full.getJSONObject(j));
      row.put("count", active.length());
      JSArray members = new JSArray();
      for (int j = 0; j < active.length(); j++) members.put(active.getJSONObject(j).getString("id"));
      row.put("memberIds", members);
      result.put(row);
    }
    JSObject response = new JSObject();
    response.put("items", result);
    permitted.requireCurrent(fence);
    return response;
  }

  /** One page of an album's visible members with previews. */
  public JSObject list(String id, String cursor) throws Exception {
    requireSupported();
    cursor = cursor == null ? "" : cursor;
    PermittedMediaCatalog.Fence fence = permitted.fence();
    JSONObject album = byId(data(), id);
    JSObject result = new JSObject();
    result.put("name", album.getString("name"));
    result.put("revision", album.getString("revision"));
    if (hasPermitted(album)) {
      String prefix = "library:" + album.getString("revision") + ":" + fence.cursorIdentity() + ":";
      int offset = 0;
      if (!cursor.isEmpty()) {
        if (!cursor.startsWith(prefix)) throw new IllegalArgumentException("Album changed");
        offset = Integer.parseInt(cursor.substring(prefix.length()));
        if (offset < 0 || offset > MAX_MEMBERS) throw new IllegalArgumentException();
      }
      List<JSONObject> rows = new ArrayList<>();
      JSArray legacy = ownedRows(album, false, Long.MAX_VALUE, MAX_MEMBERS);
      JSArray full = permittedRows(album, 0, MAX_MEMBERS);
      for (int i = 0; i < legacy.length(); i++) rows.add(legacy.getJSONObject(i));
      for (int i = 0; i < full.length(); i++) rows.add(full.getJSONObject(i));
      rows.sort((a, b) -> a.optString("id").compareTo(b.optString("id")));
      // The fence covers only the metadata listing; previews (up to 3 s each) load afterwards and
      // each permitted preview rechecks its own item revision.
      permitted.requireCurrent(fence);
      JSArray items = new JSArray();
      int end = Math.min(rows.size(), offset + OwnedMediaLibrary.PAGE);
      for (int i = offset; i < end; i++) {
        JSONObject row = rows.get(i);
        String key = row.getString("id");
        try {
          if (isPermitted(key)) row = permitted.albumItem(key, row.getString("identity"), true);
          else row.put("image", owned.preview(key, 240));
        } catch (Exception unavailable) {
          continue;
        }
        items.put(row);
      }
      result.put("items", items);
      result.put("next", end < rows.size() ? prefix + end : "");
      return result;
    }
    long before = OwnedMediaSelection.cursor(cursor);
    JSArray found = ownedRows(album, true, before, OwnedMediaLibrary.PAGE + 1);
    JSArray items = new JSArray();
    String next = "";
    for (int i = 0; i < found.length() && i < OwnedMediaLibrary.PAGE; i++)
      items.put(found.getJSONObject(i));
    if (found.length() > OwnedMediaLibrary.PAGE)
      next =
          Long.toString(
              OwnedMediaLibrary.id(
                  items.getJSONObject(OwnedMediaLibrary.PAGE - 1).getString("id")));
    result.put("items", items);
    result.put("next", next);
    return result;
  }

  /**
   * Applies {@code create}, {@code add}, {@code remove}, {@code rename} or {@code delete}.
   * Anything but {@code create} must name the album revision the renderer listed; added media must
   * name its current revision. Returns {@code saved} or {@code deleted} with the new revision.
   * {@code closed} refuses the write when the host has gone away.
   */
  public JSObject change(
      String operation,
      String id,
      String revision,
      String name,
      String mediaId,
      String mediaRevision,
      java.util.function.BooleanSupplier closed)
      throws Exception {
    requireSupported();
    synchronized (LOCK) {
      if (closed != null && closed.getAsBoolean()) throw new IllegalStateException("closed");
      JSONArray albums = data();
      operation = operation == null ? "" : operation;
      JSONObject album;
      if (operation.equals("create")) {
        if (albums.length() >= MAX_ALBUMS)
          throw new IllegalArgumentException("At most 24 custom albums are supported");
        album =
            new JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("name", OwnedMediaSelection.albumName(name))
                .put("members", new JSONArray());
        albums.put(album);
      } else {
        album = byId(albums, id == null ? "" : id);
        if (!album.getString("revision").equals(revision))
          throw new IllegalArgumentException("Album changed. Reopen it before trying again");
      }
      if (operation.equals("create") || operation.equals("add")) {
        String key = mediaId == null ? "" : mediaId;
        String identity;
        if (isPermitted(key)) identity = permitted.read(key, mediaRevision, false).getString("identity");
        else {
          if (!OwnedMediaLibrary.isOwnedKey(key))
            throw new IllegalArgumentException("Select owned media first");
          identity = owned.identity(key, mediaRevision);
        }
        JSONArray members = album.getJSONArray("members"), next = new JSONArray();
        for (int i = 0; i < members.length(); i++)
          if (!members.getJSONObject(i).getString("id").equals(key)) next.put(members.getJSONObject(i));
        if (next.length() >= MAX_MEMBERS)
          throw new IllegalArgumentException(
              isPermitted(key)
                  ? "An album supports at most 200 items"
                  : "An album supports at most 200 owned items");
        next.put(new JSONObject().put("id", key).put("identity", identity));
        album.put("members", next);
      } else if (operation.equals("remove")) {
        String key = mediaId == null ? "" : mediaId;
        JSONArray members = album.getJSONArray("members"), next = new JSONArray();
        for (int i = 0; i < members.length(); i++)
          if (!members.getJSONObject(i).getString("id").equals(key)) next.put(members.getJSONObject(i));
        if (next.length() == members.length())
          throw new IllegalArgumentException("Media is no longer in this album");
        album.put("members", next);
      } else if (operation.equals("rename")) album.put("name", OwnedMediaSelection.albumName(name));
      else if (operation.equals("delete")) {
        JSONArray next = new JSONArray();
        for (int i = 0; i < albums.length(); i++)
          if (!albums.getJSONObject(i).getString("id").equals(album.getString("id")))
            next.put(albums.getJSONObject(i));
        albums = next;
      } else throw new IllegalArgumentException("Unsupported album operation");
      album.put("revision", UUID.randomUUID().toString());
      if (!store.edit().putString("albums", albums.toString()).commit())
        throw new IllegalStateException("Album could not be saved");
      JSObject result = new JSObject();
      result.put("status", operation.equals("delete") ? "deleted" : "saved");
      result.put("id", album.getString("id"));
      result.put("revision", album.getString("revision"));
      return result;
    }
  }
}
