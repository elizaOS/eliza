package ai.eliza.plugins.media;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The host's own published photos and videos (MediaStore rows whose {@code OWNER_PACKAGE_NAME} is
 * the host package): paged listing with album and trash selection, reads with a bounded preview,
 * favorite and Recently deleted changes fenced by the listed revision and MediaStore generation,
 * bounded per-item batches, counts, and a two-step permanent removal of trashed items that applies
 * only to the confirmed generations. Owned items are named {@code <id>} (photo) or {@code v:<id>}
 * (video); the renderer never supplies a URI or a path.
 *
 * <p>The host injects its storage namespace through {@link OwnedMediaConfig}; this class stores
 * one preference file, {@code <namespace>-owned-media-versions}, recording the generation of the
 * last verified change so revisions of changed items stay distinct. {@code revokeVideo} lets the
 * host revoke playback grants of a trashed or deleted video. Calls block; run them off the main
 * thread.
 */
public final class OwnedMediaLibrary {
  /** A list page holds at most this many items. */
  public static final int PAGE = 24;
  /** A batch change, share or reviewed removal names at most this many items. */
  public static final int BATCH = 20;
  /** Trash removal prepares at most this many items at once. */
  public static final int TRASH_LIMIT = 500;
  /** A prepared removal expires after this many milliseconds. */
  public static final long CONFIRMATION_MS = 120000;

  /** Thrown when more items are in trash than one confirmation may name. */
  public static final class TooManyTrashed extends IllegalStateException {
    TooManyTrashed() {
      super("More than " + TRASH_LIMIT + " owned items are in trash.");
    }
  }

  private static final Uri CATALOG = MediaStore.Files.getContentUri("external");
  private static final String MEDIA = " AND media_type IN (1,3)";
  private static final String[] FIELDS = {
    MediaStore.Images.Media._ID,
    MediaStore.Images.Media.WIDTH,
    MediaStore.Images.Media.HEIGHT,
    MediaStore.Images.Media.DATE_ADDED,
    MediaStore.Images.Media.SIZE,
    MediaStore.Files.FileColumns.MEDIA_TYPE,
    MediaStore.Video.VideoColumns.DURATION
  };

  private final Context context;
  private final SharedPreferences versions;
  private final Consumer<Uri> revokeVideo;
  private final LinkedHashMap<String, Confirmation> confirmations = new LinkedHashMap<>();

  private static final class TrashItem {
    final String key;
    final long generation;

    TrashItem(String key, long generation) {
      this.key = key;
      this.generation = generation;
    }
  }

  private static final class Confirmation {
    final long until = SystemClock.elapsedRealtime() + CONFIRMATION_MS;
    final List<TrashItem> items;

    Confirmation(List<TrashItem> items) {
      this.items = List.copyOf(items);
    }
  }

  public OwnedMediaLibrary(Context context, OwnedMediaConfig config, Consumer<Uri> revokeVideo) {
    this.context = context.getApplicationContext();
    this.versions =
        this.context.getSharedPreferences(config.preferences("owned-media-versions"), 0);
    this.revokeVideo = revokeVideo == null ? uri -> {} : revokeVideo;
  }

  /** True when {@code key} is an owned item name ({@code <id>} or {@code v:<id>}). */
  public static boolean isOwnedKey(String key) {
    return OwnedMediaSelection.isOwnedKey(key);
  }

  /** The MediaStore id of an owned item name. */
  public static long id(String key) {
    return OwnedMediaSelection.id(key);
  }

  public static boolean video(String key) {
    return key != null && key.startsWith("v:");
  }

  /** The typed content URI of an owned item name; this alone grants nothing. */
  public static Uri uri(String key) {
    return uri(id(key), video(key));
  }

  private static Uri uri(long id, boolean video) {
    return ContentUris.withAppendedId(
        video
            ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            : MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        id);
  }

  private String owner() {
    return context.getPackageName();
  }

  private String owned(boolean trashed) {
    return OwnedMediaSelection.owned(Build.VERSION.SDK_INT, trashed);
  }

  private static String[] fields() {
    String[] result = Arrays.copyOf(FIELDS, Build.VERSION.SDK_INT < 30 ? 8 : 13);
    if (Build.VERSION.SDK_INT >= 30) {
      result[7] = MediaStore.MediaColumns.IS_TRASHED;
      result[8] = MediaStore.MediaColumns.DATE_EXPIRES;
      result[9] = MediaStore.MediaColumns.GENERATION_MODIFIED;
      result[10] = MediaStore.MediaColumns.IS_FAVORITE;
      result[11] = MediaStore.MediaColumns.GENERATION_ADDED;
    }
    result[result.length - 1] = MediaStore.MediaColumns.DATE_MODIFIED;
    return result;
  }

  /**
   * The item's content as of this read: modified time, byte size and (API 30+) MediaStore's
   * modification generation. Unlike the mutation revision it changes when another writer rewrites
   * the file in place at the same size, so a photo used as context is refused when it differs.
   */
  private static String contentRevision(Cursor row) {
    return row.getLong(row.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED))
        + ":"
        + row.getLong(4)
        + (Build.VERSION.SDK_INT >= 30 ? ":" + row.getLong(9) : "");
  }

  private static String mutationRevision(Cursor row) {
    return OwnedMediaSelection.revision(
        Build.VERSION.SDK_INT,
        row.getLong(3),
        row.getLong(4),
        Build.VERSION.SDK_INT >= 30 ? row.getLong(9) : 0,
        Build.VERSION.SDK_INT >= 30 ? row.getInt(7) : 0);
  }

  /** Stable identity of one owned item for album membership: date added, size, generation added. */
  private static String identity(Cursor row) {
    return row.getLong(3) + ":" + row.getLong(4) + ":" + row.getLong(11);
  }

  private static String key(Cursor row) {
    return (row.getInt(5) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO ? "v:" : "")
        + row.getLong(0);
  }

  private JSObject metadata(Cursor row) {
    JSObject item = new JSObject();
    boolean video = row.getInt(5) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
    String key = key(row);
    item.put("id", key);
    item.put("kind", video ? "video" : "image");
    item.put("duration", video ? row.getLong(6) / 1000d : 0);
    item.put("width", row.getInt(1));
    item.put("height", row.getInt(2));
    item.put("date", row.getLong(3) * 1000);
    String base = row.getLong(3) + ":" + row.getLong(4);
    String marker = versions.getString(key, "");
    item.put(
        "revision",
        base
            + (Build.VERSION.SDK_INT >= 30 && marker.startsWith(base + "|")
                ? "|" + row.getLong(9)
                : ""));
    item.put("mutationRevision", mutationRevision(row));
    item.put("contentRevision", contentRevision(row));
    item.put("trashed", Build.VERSION.SDK_INT >= 30 && row.getInt(7) == 1);
    item.put("favorite", Build.VERSION.SDK_INT >= 30 && row.getInt(10) == 1);
    item.put("expiresAt", Build.VERSION.SDK_INT >= 30 ? row.getLong(8) * 1000 : 0);
    return item;
  }

  /** A JPEG data URL of the item scaled to at most {@code size} px on its long edge. */
  public String preview(String key, int size) throws Exception {
    Uri uri = uri(key);
    ContentResolver resolver = context.getContentResolver();
    Bitmap bitmap =
        video(key)
            ? resolver.loadThumbnail(uri, new Size(size, size), null)
            : ImageDecoder.decodeBitmap(
                ImageDecoder.createSource(resolver, uri),
                (decoder, info, source) -> {
                  double scale =
                      Math.min(
                          1d,
                          (double) size
                              / Math.max(info.getSize().getWidth(), info.getSize().getHeight()));
                  decoder.setTargetSize(
                      Math.max(1, (int) (info.getSize().getWidth() * scale)),
                      Math.max(1, (int) (info.getSize().getHeight() * scale)));
                  decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                });
    try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 85, output))
        throw new IllegalStateException();
      return "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
    } finally {
      bitmap.recycle();
    }
  }

  private void putPreview(JSObject item, String key, int size) {
    try {
      item.put("image", preview(key, size));
    } catch (Exception unavailable) {
      item.put("image", "");
    }
  }

  private Bundle single(String key, boolean trashed) {
    Bundle query = new Bundle();
    query.putString(
        ContentResolver.QUERY_ARG_SQL_SELECTION, owned(trashed) + " AND _id=? AND media_type=?");
    query.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
        new String[] {owner(), Long.toString(id(key)), video(key) ? "3" : "1"});
    if (Build.VERSION.SDK_INT >= 30)
      query.putInt(
          MediaStore.QUERY_ARG_MATCH_TRASHED,
          trashed ? MediaStore.MATCH_ONLY : MediaStore.MATCH_EXCLUDE);
    return query;
  }

  /**
   * One page of owned items, newest first. {@code album} is {@code ""}, {@code "favorites"} or
   * {@code "videos"}; trash has no albums.
   */
  public JSObject list(String before, boolean trashed, String album) throws Exception {
    if (trashed && Build.VERSION.SDK_INT < 30)
      throw new UnsupportedOperationException("Android trash requires Android 11 or later");
    long cursor = OwnedMediaSelection.cursor(before);
    Bundle query = new Bundle();
    query.putString(
        ContentResolver.QUERY_ARG_SQL_SELECTION,
        OwnedMediaSelection.page(Build.VERSION.SDK_INT, trashed, album == null ? "" : album));
    query.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
        new String[] {owner(), Long.toString(cursor)});
    query.putStringArray(
        ContentResolver.QUERY_ARG_SORT_COLUMNS, new String[] {MediaStore.Images.Media._ID});
    query.putInt(
        ContentResolver.QUERY_ARG_SORT_DIRECTION, ContentResolver.QUERY_SORT_DIRECTION_DESCENDING);
    query.putInt(ContentResolver.QUERY_ARG_LIMIT, PAGE + 1);
    if (Build.VERSION.SDK_INT >= 30)
      query.putInt(
          MediaStore.QUERY_ARG_MATCH_TRASHED,
          trashed ? MediaStore.MATCH_ONLY : MediaStore.MATCH_EXCLUDE);
    JSArray items = new JSArray();
    String next = "";
    long last = 0;
    try (Cursor rows = context.getContentResolver().query(CATALOG, fields(), query, null)) {
      if (rows == null) throw new IllegalStateException();
      while (rows.moveToNext()) {
        if (items.length() == PAGE) {
          next = Long.toString(last);
          break;
        }
        JSObject item = metadata(rows);
        last = rows.getLong(0);
        putPreview(item, key(rows), 240);
        items.put(item);
      }
    }
    JSObject result = new JSObject();
    result.put("items", items);
    result.put("next", next);
    return result;
  }

  /** Metadata and a 1024 px preview of one owned item; trashed items only when asked. */
  public JSObject read(String key, boolean trashed) throws Exception {
    JSObject result = metadata(key, trashed);
    result.put("image", preview(key, 1024));
    return result;
  }

  /** Metadata of one owned, fully written item; throws when it is gone or in the other state. */
  public JSObject metadata(String key, boolean trashed) throws Exception {
    try (Cursor row =
        context.getContentResolver().query(CATALOG, fields(), single(key, trashed), null)) {
      if (row == null || !row.moveToFirst())
        throw new IllegalArgumentException("Media is no longer available");
      return metadata(row);
    }
  }

  /**
   * The URI of an owned, untrashed item after checking it still exists and, when {@code
   * expectedMutationRevision} is not null, that it is unchanged.
   */
  public Uri verified(String key, String expectedMutationRevision) throws Exception {
    JSObject item = metadata(key, false);
    if (expectedMutationRevision != null
        && !expectedMutationRevision.equals(item.getString("mutationRevision")))
      throw new IllegalArgumentException("Media changed. Reselect it before trying again");
    return uri(key);
  }

  /** Album identity of an owned, untrashed item whose mutation revision is {@code expected}. */
  public String identity(String key, String expected) throws Exception {
    try (Cursor row =
        context.getContentResolver().query(CATALOG, fields(), single(key, false), null)) {
      if (row == null || !row.moveToFirst() || !mutationRevision(row).equals(expected))
        throw new IllegalArgumentException("Media changed. Reselect it before trying again");
      return identity(row);
    }
  }

  /**
   * Owned, untrashed members whose identity still matches, newest first and below {@code before}.
   * A member another writer replaced is withheld, not listed under its old identity.
   */
  public JSArray members(Map<String, String> identities, boolean previews, long before, int limit)
      throws Exception {
    JSArray result = new JSArray();
    if (identities.isEmpty()) return result;
    List<String> args = new ArrayList<>();
    args.add(owner());
    StringBuilder ids = new StringBuilder();
    for (String key : identities.keySet()) {
      if (ids.length() > 0) ids.append(',');
      ids.append('?');
      args.add(Long.toString(id(key)));
    }
    try (Cursor rows =
        context
            .getContentResolver()
            .query(
                CATALOG,
                fields(),
                owned(false) + MEDIA + " AND _id IN (" + ids + ")",
                args.toArray(new String[0]),
                "_id DESC")) {
      if (rows == null) throw new IllegalStateException();
      while (rows.moveToNext()) {
        String key = key(rows);
        if (rows.getLong(0) >= before || !identity(rows).equals(identities.get(key))) continue;
        JSObject row = metadata(rows);
        if (previews) putPreview(row, key, 240);
        result.put(row);
        if (result.length() >= limit) break;
      }
    }
    return result;
  }

  /**
   * Sets favorite or Recently deleted on one owned item, only when its mutation revision and
   * MediaStore generation are still the ones listed. Throws {@code IllegalStateException("stale")}
   * when the item changed and {@code "unverified"} when the write could not be read back.
   */
  public JSObject changeFlag(String key, String revision, boolean favorite, boolean desired)
      throws Exception {
    if (Build.VERSION.SDK_INT < 30) throw new UnsupportedOperationException("unsupported");
    if (!isOwnedKey(key) || revision == null || revision.isEmpty() || revision.length() > 160)
      throw new IllegalArgumentException("invalid");
    long itemId = id(key);
    boolean video = video(key);
    Bundle query = new Bundle();
    query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
    String selection =
        MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=? AND is_pending=0 AND _id=? AND media_type=?";
    String[] args = {owner(), Long.toString(itemId), video ? "3" : "1"};
    query.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
    query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
    long generation;
    try (Cursor row = context.getContentResolver().query(CATALOG, fields(), query, null)) {
      if (row == null
          || !row.moveToFirst()
          || !revision.equals(mutationRevision(row))
          || (favorite && row.getInt(7) != 0)) throw new IllegalStateException("stale");
      if ((row.getInt(favorite ? 10 : 7) == 1) == desired) {
        JSObject unchanged = metadata(row);
        unchanged.put("status", "unchanged");
        return unchanged;
      }
      generation = row.getLong(9);
    }
    ContentValues values = new ContentValues();
    values.put(
        favorite ? MediaStore.MediaColumns.IS_FAVORITE : MediaStore.MediaColumns.IS_TRASHED,
        desired ? 1 : 0);
    Bundle update = new Bundle(query);
    update.putString(
        ContentResolver.QUERY_ARG_SQL_SELECTION,
        selection
            + " AND generation_modified=? AND "
            + (favorite ? "is_trashed=0 AND is_favorite" : "is_trashed")
            + "=?");
    update.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
        new String[] {args[0], args[1], args[2], Long.toString(generation), desired ? "0" : "1"});
    int changed = context.getContentResolver().update(uri(itemId, video), values, update);
    if (changed != 1) throw new IllegalStateException("stale");
    if (video && !favorite) revokeVideo.accept(uri(itemId, true));
    try (Cursor row = context.getContentResolver().query(CATALOG, fields(), query, null)) {
      if (row == null || !row.moveToFirst() || (row.getInt(favorite ? 10 : 7) == 1) != desired)
        throw new IllegalStateException("unverified");
      String base = row.getLong(3) + ":" + row.getLong(4);
      if (!versions.edit().putString(key, base + "|" + row.getLong(9)).commit())
        throw new IllegalStateException("unverified");
      JSObject result = metadata(row);
      result.put(
          "status",
          favorite
              ? (desired ? "favorited" : "unfavorited")
              : (desired ? "trashed" : "restored"));
      return result;
    }
  }

  /**
   * A bounded per-item batch of {@code favorite}, {@code trash} or {@code restore} over 1–20
   * distinct owned items. The whole request is validated before the first write; each item then
   * reports its own outcome, so the result is {@code complete} or {@code partial}, never an
   * all-or-nothing promise. {@code closed} stops further writes when the host goes away.
   */
  public JSObject changeMany(String operation, JSONArray items, BooleanSupplier closed)
      throws Exception {
    if (!"favorite".equals(operation) && !"trash".equals(operation) && !"restore".equals(operation))
      throw new IllegalArgumentException();
    if (items == null || items.length() < 1 || items.length() > BATCH)
      throw new IllegalArgumentException();
    Set<String> seen = new HashSet<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.getJSONObject(i);
      String key = item.getString("id"), revision = item.getString("revision");
      if (!isOwnedKey(key) || !seen.add(key) || revision.isEmpty() || revision.length() > 160)
        throw new IllegalArgumentException();
    }
    JSArray outcomes = new JSArray();
    int verified = 0;
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.getJSONObject(i);
      JSObject outcome = new JSObject();
      outcome.put("id", item.getString("id"));
      try {
        if (closed != null && closed.getAsBoolean()) throw new IllegalStateException("unverified");
        JSObject result =
            changeFlag(
                item.getString("id"),
                item.getString("revision"),
                operation.equals("favorite"),
                !operation.equals("restore"));
        outcome.put("status", result.getString("status"));
        outcome.put("item", result);
        verified++;
      } catch (IllegalStateException stale) {
        outcome.put("status", "stale".equals(stale.getMessage()) ? "stale" : "unverified");
      } catch (Exception failed) {
        outcome.put("status", Build.VERSION.SDK_INT < 30 ? "unsupported" : "unverified");
      }
      outcomes.put(outcome);
    }
    JSObject result = new JSObject();
    result.put("status", verified == items.length() ? "complete" : "partial");
    result.put("outcomes", outcomes);
    return result;
  }

  /** Counts of owned favorites, videos and trash. */
  public JSObject summary() throws Exception {
    Bundle query = new Bundle();
    query.putString(
        ContentResolver.QUERY_ARG_SQL_SELECTION,
        MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=? AND is_pending=0" + MEDIA);
    query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] {owner()});
    if (Build.VERSION.SDK_INT >= 30)
      query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
    int favorite = 0, videos = 0, trash = 0;
    try (Cursor rows = context.getContentResolver().query(CATALOG, fields(), query, null)) {
      if (rows == null) throw new IllegalStateException();
      while (rows.moveToNext()) {
        if (Build.VERSION.SDK_INT >= 30 && rows.getInt(7) == 1) {
          trash++;
          continue;
        }
        if (rows.getInt(5) == 3) videos++;
        if (Build.VERSION.SDK_INT >= 30 && rows.getInt(10) == 1) favorite++;
      }
    }
    JSObject result = new JSObject();
    result.put("favorites", favorite);
    result.put("videos", videos);
    result.put("trash", trash);
    result.put("canFavorite", Build.VERSION.SDK_INT >= 30);
    return result;
  }

  /**
   * Prepares removal of the named owned trashed items. A null or empty list is refused: it never
   * means "every trashed item". Use {@link #prepareDeleteAllTrash()} for an explicit empty-trash.
   */
  public JSObject prepareDeleteTrash(JSONArray requested) throws Exception {
    return prepareDeleteTrash(TrashDeleteRequest.named(requested));
  }

  /** Prepares removal of every owned trashed item; only for an explicit "empty trash" intent. */
  public JSObject prepareDeleteAllTrash() throws Exception {
    return prepareDeleteTrash(TrashDeleteRequest.all());
  }

  /**
   * First step of permanent removal: snapshots the generation of every owned trashed item (for
   * {@link TrashDeleteRequest#all()}) or of the 1–20 named ones, whose revisions must match, and
   * returns a confirmation token valid for two minutes. At most four confirmations are pending;
   * nothing is removed here.
   */
  public synchronized JSObject prepareDeleteTrash(TrashDeleteRequest request) throws Exception {
    if (request == null) throw new IllegalArgumentException("Select deleted items again");
    if (Build.VERSION.SDK_INT < 30)
      throw new UnsupportedOperationException("Android trash requires Android 11 or later");
    Map<String, String> wanted = request.items();
    boolean named = !request.isAll();
    String selection = owned(true) + MEDIA;
    List<String> args = new ArrayList<>();
    args.add(owner());
    if (named) {
      StringBuilder ids = new StringBuilder();
      for (String key : wanted.keySet()) {
        if (ids.length() > 0) ids.append(',');
        ids.append('?');
        args.add(Long.toString(id(key)));
      }
      selection += " AND _id IN (" + ids + ")";
    }
    Bundle query = new Bundle();
    query.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
    query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toArray(new String[0]));
    query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_ONLY);
    query.putInt(ContentResolver.QUERY_ARG_LIMIT, TRASH_LIMIT + 1);
    List<TrashItem> items = new ArrayList<>();
    try (Cursor rows = context.getContentResolver().query(CATALOG, fields(), query, null)) {
      if (rows == null) throw new IllegalStateException();
      while (rows.moveToNext()) {
        if (items.size() >= TRASH_LIMIT) throw new TooManyTrashed();
        String key = key(rows);
        if (named) {
          if (!wanted.containsKey(key)) continue;
          if (!mutationRevision(rows).equals(wanted.get(key))) throw new IllegalArgumentException();
        }
        items.add(new TrashItem(key, rows.getLong(9)));
      }
    }
    if (named && items.size() != wanted.size()) throw new IllegalArgumentException();
    long now = SystemClock.elapsedRealtime();
    confirmations.entrySet().removeIf(entry -> entry.getValue().until < now);
    while (confirmations.size() >= 4) confirmations.remove(confirmations.keySet().iterator().next());
    String token = UUID.randomUUID().toString();
    confirmations.put(token, new Confirmation(items));
    JSObject result = new JSObject();
    result.put("confirmation", token);
    result.put("count", items.size());
    return result;
  }

  public synchronized void cancelDeleteTrash(String token) {
    confirmations.remove(token == null ? "" : token);
  }

  /**
   * Second step: removes each confirmed item only while it is still trashed at the confirmed
   * generation. A restored or changed item is skipped, never removed. Throws when the token is
   * unknown or expired; {@code closed} marks the rest failed when the host goes away.
   */
  public JSObject deletePreparedTrash(String token, BooleanSupplier closed) {
    if (Build.VERSION.SDK_INT < 30)
      throw new UnsupportedOperationException("Android trash requires Android 11 or later");
    Confirmation confirmation;
    synchronized (this) {
      confirmation = confirmations.remove(token == null ? "" : token);
    }
    if (confirmation == null || confirmation.until < SystemClock.elapsedRealtime())
      throw new IllegalStateException("Delete confirmation expired. Review trash again.");
    JSArray deleted = new JSArray(), skipped = new JSArray(), failed = new JSArray();
    for (TrashItem item : confirmation.items) {
      if (closed != null && closed.getAsBoolean()) {
        failed.put(item.key);
        continue;
      }
      try {
        boolean video = video(item.key);
        long itemId = id(item.key);
        // A typed URI delete can reject a now-restored row before applying the SQL predicate.
        // Classify immutable-snapshot mismatches without requesting deletion.
        Bundle inspect = new Bundle();
        inspect.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
        inspect.putString(
            ContentResolver.QUERY_ARG_SQL_SELECTION,
            MediaStore.MediaColumns.OWNER_PACKAGE_NAME
                + "=? AND is_pending=0 AND _id=? AND media_type=?");
        inspect.putStringArray(
            ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
            new String[] {owner(), Long.toString(itemId), video ? "3" : "1"});
        try (Cursor row = context.getContentResolver().query(CATALOG, fields(), inspect, null)) {
          if (row == null) throw new IllegalStateException();
          if (!row.moveToFirst() || row.getInt(7) != 1 || row.getLong(9) != item.generation) {
            skipped.put(item.key);
            continue;
          }
        }
        Bundle query = new Bundle();
        query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_ONLY);
        query.putString(
            ContentResolver.QUERY_ARG_SQL_SELECTION,
            owned(true) + " AND _id=? AND media_type=? AND generation_modified=?");
        query.putStringArray(
            ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
            new String[] {
              owner(), Long.toString(itemId), video ? "3" : "1", Long.toString(item.generation)
            });
        int count = context.getContentResolver().delete(uri(itemId, video), query);
        if (count == 1) {
          deleted.put(item.key);
          versions.edit().remove(item.key).apply();
          if (video) revokeVideo.accept(uri(itemId, true));
        } else skipped.put(item.key);
      } catch (Exception failure) {
        failed.put(item.key);
      }
    }
    JSObject result = new JSObject();
    result.put("deletedIds", deleted);
    result.put("skippedIds", skipped);
    result.put("failedIds", failed);
    result.put("status", skipped.length() + failed.length() == 0 ? "deleted" : "partial");
    return result;
  }

  /**
   * MIME type for one share of several URIs: the common type, else {@code image/*} or {@code
   * video/*} when they share a family, else any type. Each URI must be openable.
   */
  public static String shareType(ContentResolver resolver, List<Uri> uris) throws Exception {
    String mime = null;
    for (Uri uri : uris) {
      try (android.content.res.AssetFileDescriptor file =
          resolver.openAssetFileDescriptor(uri, "r")) {
        if (file == null) throw new IllegalArgumentException();
      }
      String type = resolver.getType(uri);
      if (type == null) type = "application/octet-stream";
      mime = OwnedMediaSelection.shareType(mime, type);
    }
    if (mime == null) throw new IllegalArgumentException();
    return mime;
  }
}
