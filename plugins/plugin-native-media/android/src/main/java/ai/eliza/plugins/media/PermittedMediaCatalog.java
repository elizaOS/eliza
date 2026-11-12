package ai.eliza.plugins.media;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.UserManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Same-user, permission-filtered access to the full permitted device photo and video library, not
 * only media the host published. Every read holds a fence over the granted scope, the device
 * lock/foreground state, the media volumes and their MediaStore versions/generations, so a page,
 * read or reviewed change is refused when access or the library changed underneath it. Rows are
 * named by {@link MediaLibraryKey}; changes need the caller's reviewed one-shot authority
 * ({@link PermittedMediaReview}) and an exact row revision. No media bytes or index are uploaded.
 */
public final class PermittedMediaCatalog implements AutoCloseable {
  private static final int PAGE_SIZE = 24;
  /** Bounds of a read's preview edge in pixels; never the original bytes. */
  public static final int PREVIEW_MIN = 64, PREVIEW_MAX = 2048;
  private static final String[] FIELDS = {"_id", "width", "height", "date_added", "_size",
      MediaStore.MediaColumns.DISPLAY_NAME, "date_modified", "owner_package_name",
      "generation_added", "generation_modified", "is_favorite", "is_trashed", "date_expires"};
  private final Context context;
  private final ContentResolver resolver;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final AtomicLong epoch = new AtomicLong();
  private final java.util.concurrent.CopyOnWriteArrayList<Runnable> listeners =
      new java.util.concurrent.CopyOnWriteArrayList<>();
  /** Views that currently need MediaStore observation (Photos grid, Device library album). */
  private final java.util.Set<String> watchers = new java.util.HashSet<>();
  private volatile boolean closed, foreground = true;
  private final android.content.BroadcastReceiver screenOff =
      new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context c, android.content.Intent intent) {
          invalidate();
        }
      };
  private final LinkedHashMap<String, Page> pages = new LinkedHashMap<>();
  private final ContentObserver observer = new ContentObserver(main) {
    @Override
    public void onChange(boolean selfChange) {
      invalidate();
      for (Runnable listener : listeners) listener.run();
    }
  };
  private static final class Page {
    final String snapshot, query, kind;
    /** The last listed item's catalog key: capture time, source (volume x type) and _id. */
    final long shot, id;
    final int source;
    final long until;
    Page(String snapshot, String query, String kind, long shot, int source, long id) {
      this.snapshot = snapshot;
      this.query = query;
      this.kind = kind;
      this.shot = shot;
      this.source = source;
      this.id = id;
      until = SystemClock.elapsedRealtime() + 120000;
    }
  }
  /**
   * The catalog's sort time in SQL: DATE_TAKEN, or date_added (seconds) when it is unset. It must
   * equal {@link #shot(Cursor)}, which computes the same value for a listed row.
   */
  static final String SHOT = "ifnull(nullif(datetaken,0),date_added*1000)";
  private static long shot(Cursor row) {
    int taken = row.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_TAKEN);
    long value = row.isNull(taken) ? 0 : row.getLong(taken);
    return value != 0 ? value : row.getLong(3) * 1000;
  }
  /** Catalog order of merged rows {shot, source, _id, item}: newest first, then source, then _id desc. */
  static final java.util.Comparator<Object[]> CATALOG_ORDER = (a, b) -> {
    int byShot = Long.compare((Long) b[0], (Long) a[0]);
    if (byShot != 0) return byShot;
    int bySource = Integer.compare((Integer) a[1], (Integer) b[1]);
    return bySource != 0 ? bySource : Long.compare((Long) b[2], (Long) a[2]);
  };
  /**
   * Rows of {@code source} that come after the key (shot, source, id) in catalog order: newest
   * capture time first, then source index, then _id descending. {@code args} receives the values.
   */
  // MediaStore binds selection arguments as text; the capture-time expression has no affinity.
  static final String NUMBER = "CAST(? AS INTEGER)";
  static String after(int source, long shot, int lastSource, long id, List<String> args) {
    args.add(Long.toString(shot));
    if (source < lastSource)
      return " AND " + SHOT + "<" + NUMBER;
    if (source > lastSource)
      return " AND " + SHOT + "<=" + NUMBER;
    args.add(Long.toString(shot));
    args.add(Long.toString(id));
    return " AND (" + SHOT + "<" + NUMBER + " OR (" + SHOT + "=" + NUMBER + " AND _id<" + NUMBER + "))";
  }
  private boolean observing;
  private final PhotoLibraryAccess.Profile profile;
  public PermittedMediaCatalog(Context context, Runnable changed) {
    this(context, true, changed);
  }
  public PermittedMediaCatalog(Context context, boolean active, Runnable changed) {
    this(context, active, changed, PhotoLibraryAccess.Profile.LIBRARY);
  }
  /** A catalog that reads only what {@code profile} allows. */
  public PermittedMediaCatalog(Context context, boolean active, Runnable changed,
      PhotoLibraryAccess.Profile profile) {
    this.profile = profile;
    this.context = context;
    listeners.add(changed);
    resolver = context.getContentResolver();

    androidx.core.content.ContextCompat.registerReceiver(context, screenOff,
        new android.content.IntentFilter(android.content.Intent.ACTION_SCREEN_OFF),
        androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
    watch(active);
  }
  /** One catalog serves every permitted-media surface; each adds its own change listener. */
  public void addListener(Runnable listener) {
    listeners.add(listener);
  }
  public synchronized void watch(boolean active) {
    watch("default", active);
  }
  /** The MediaStore observer is registered only while at least one view watches. */
  public synchronized void watch(String view, boolean active) {
    if (active && !closed)
      watchers.add(view);
    else
      watchers.remove(view);
    boolean wanted = !watchers.isEmpty() && !closed;
    if (wanted && !observing) {
      resolver.registerContentObserver(MediaStore.AUTHORITY_URI, true, observer);
      observing = true;
    } else if (!wanted && observing) {
      resolver.unregisterContentObserver(observer);
      observing = false;
    }
  }
  public void foreground(boolean value) {
    foreground = value;
    invalidate();
  }
  private String lastReadAccess = "";
  private synchronized void checkReadAccess() {
    String current = access().toString();
    if (!current.equals(lastReadAccess)) {
      lastReadAccess = current;
      invalidate();
    }
  }
  public long readTicket() {
    unlocked();
    checkReadAccess();
    return epoch.get();
  }
  public void requireReadTicket(long ticket) {
    unlocked();
    checkReadAccess();
    if (ticket != epoch.get())
      throw new SecurityException("Media access changed");
  }
  public void publish(com.getcapacitor.PluginCall call, JSObject value, long ticket) {
    publish(call, value, ticket, null);
  }
  public void publish(com.getcapacitor.PluginCall call, JSObject value, long ticket,
      Runnable onPublished) {
    main.post(() -> {
      try {
        requireReadTicket(ticket);
        call.resolve(value);
      } catch (Exception changed) {
        call.reject("Media access changed. Reopen Photos and reload.");
        return;
      }
      if (onPublished != null) onPublished.run();
    });
  }
  public void invalidate() {
    epoch.incrementAndGet();
    synchronized (pages) {
      pages.clear();
    }
  }
  private boolean granted(String permission) {
    return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
  }
  public JSObject access() {
    int sdk = Build.VERSION.SDK_INT;
    String[] answer = PhotoLibraryAccess.access(profile, sdk,
        sdk < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE),
        sdk >= 33 && granted(Manifest.permission.READ_MEDIA_IMAGES),
        sdk >= 33 && granted(Manifest.permission.READ_MEDIA_VIDEO),
        sdk >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED));
    JSObject result = new JSObject();
    result.put("images", answer[1]);
    result.put("videos", answer[2]);
    result.put("scope", answer[0]);
    return result;
  }
  private void unlocked() {
    KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
    UserManager users = context.getSystemService(UserManager.class);
    if (closed || !foreground || keyguard == null || users == null || keyguard.isDeviceLocked()
        || !users.isUserUnlocked() || (Build.VERSION.SDK_INT >= 31 && !users.isUserForeground()))
      throw new SecurityException("Unlock this profile to use Photos");
  }
  private List<String> volumes() {
    List<String> result = new ArrayList<>(MediaStore.getExternalVolumeNames(context));
    Collections.sort(result);
    if (result.size() > 16)
      throw new IllegalStateException("Too many media volumes");
    return result;
  }
  private String version(String volume) {
    String value = Build.VERSION.SDK_INT >= 30 ? MediaStore.getVersion(context, volume)
                                               : MediaStore.getVersion(context);
    if (value == null || value.isEmpty())
      throw new IllegalStateException("Media version unavailable");
    return value;
  }
  private String snapshot(List<String> volumes) {
    unlocked();
    StringBuilder value = new StringBuilder(access().toString()).append('|').append(epoch.get());
    for (String volume : volumes) {
      value.append('|').append(volume).append('=').append(version(volume));
      if (Build.VERSION.SDK_INT >= 30)
        value.append(':').append(MediaStore.getGeneration(context, volume));
    }
    return value.toString();
  }
  private void current(String expected, List<String> volumes) {
    if (!expected.equals(snapshot(volumes)) || !volumes.equals(volumes()))
      throw new IllegalStateException("Photo access or library changed; refresh Photos");
  }
  public static final class Fence {
    final List<String> volumes;
    final String snapshot;
    /**
     * {@code SystemClock.elapsedRealtime()} deadline after which {@link #requireCurrent} refuses
     * this fence. Hosts' instrumentation reads it to tell a library change from an expired query.
     */
    public final long until = SystemClock.elapsedRealtime() + 5000;
    Fence(List<String> volumes, String snapshot) {
      this.volumes = List.copyOf(volumes);
      this.snapshot = snapshot;
    }
    public String cursorIdentity() throws Exception {
      return Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(
                                       snapshot.getBytes(java.nio.charset.StandardCharsets.UTF_8)),
          Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
  }
  public Fence fence() {
    List<String> volumes = volumes();
    return new Fence(volumes, snapshot(volumes));
  }
  /**
   * The published scope version: granted access plus each volume's MediaStore version, so it
   * changes on a new grant or a rebuilt or removed volume. It leaves out the epoch and generation
   * that {@link Fence#cursorIdentity} holds, so pausing, locking or editing a row keeps it; row
   * changes reach watchers as library changes instead.
   */
  public String scopeVersion() throws Exception {
    unlocked();
    StringBuilder value = new StringBuilder(access().toString());
    for (String volume : volumes()) value.append('|').append(volume).append('=').append(version(volume));
    return Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(
                                     value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)),
        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
  }
  /** A {@code next} cursor from before a pause, lock or change; the caller pages again from the start. */
  public static final class StaleCursor extends IllegalStateException {
    StaleCursor() {
      super("Photo page expired; refresh Photos");
    }
  }
  /**
   * Each volume's MediaStore generation, which moves on any row change, even one made while
   * paused and unobserved. Empty below Android 11, which has no generation.
   */
  public String generations() {
    unlocked();
    if (Build.VERSION.SDK_INT < 30) return "";
    StringBuilder value = new StringBuilder();
    for (String volume : volumes())
      value.append('|').append(volume).append('=').append(MediaStore.getGeneration(context, volume));
    return value.toString();
  }
  public void requireCurrent(Fence fence) {
    if (SystemClock.elapsedRealtime() > fence.until)
      throw new IllegalStateException("Media query took too long; refresh Photos");
    current(fence.snapshot, fence.volumes);
  }
  private String[] fields(boolean video) {
    List<String> result = new ArrayList<>(java.util.Arrays.asList(
        Build.VERSION.SDK_INT >= 30 ? FIELDS : java.util.Arrays.copyOf(FIELDS, 8)));
    if (video)
      result.add(MediaStore.Video.VideoColumns.DURATION);
    result.add(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME);
    result.add(MediaStore.MediaColumns.DATE_TAKEN);
    if (Build.VERSION.SDK_INT >= 29)
      result.add(MediaStore.MediaColumns.RELATIVE_PATH);
    return result.toArray(new String[0]);
  }
  private String revision(Cursor row, String volume) {
    // The provider version rejects recycled row IDs after a database rebuild.
    return version(volume) + ":" + row.getLong(3) + ":" + row.getLong(4) + ":" + row.getLong(6)
        + (Build.VERSION.SDK_INT >= 30 ? ":" + row.getLong(8) + ":" + row.getLong(9) : "");
  }
  private JSObject metadata(Cursor row, String volume, boolean video) {
    MediaLibraryKey key = new MediaLibraryKey(volume, row.getLong(0), video);
    JSObject result = new JSObject();
    result.put("id", key.toString());
    result.put("kind", key.video ? "video" : "image");
    result.put("width", row.getInt(1));
    result.put("height", row.getInt(2));
    result.put("date", row.getLong(3) * 1000);
    result.put("size", row.getLong(4));
    result.put("duration",
        video
            ? row.getLong(row.getColumnIndexOrThrow(MediaStore.Video.VideoColumns.DURATION)) / 1000d
            : 0);
    String name = row.getString(5);
    result.put("name", name == null ? "" : name.substring(0, Math.min(256, name.length())));
    result.put("revision", revision(row, volume));
    result.put("mutationRevision", revision(row, volume));
    result.put("favorite", Build.VERSION.SDK_INT >= 30 && row.getInt(10) == 1);
    result.put("owned", context.getPackageName().equals(row.getString(7)));
    result.put("trashed", Build.VERSION.SDK_INT >= 30 && row.getInt(11) == 1);
    result.put("expiresAt", Build.VERSION.SDK_INT >= 30 ? row.getLong(12) * 1000 : 0);
    result.put("identity",
        version(volume) + ":" + row.getLong(3)
            + (Build.VERSION.SDK_INT >= 30 ? ":" + row.getLong(8) : ""));
    // The folder Android files the item under, and when it was taken (0 when unknown).
    int bucket = row.getColumnIndex(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME);
    String folder = bucket < 0 || row.isNull(bucket) ? "" : row.getString(bucket);
    result.put("bucket", folder.substring(0, Math.min(256, folder.length())));
    int taken = row.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN);
    result.put("dateTaken", taken < 0 || row.isNull(taken) ? 0 : row.getLong(taken));
    OwnedMediaLibrary.putPlace(result, row);
    return result;
  }
  public Uri uri(MediaLibraryKey key) {
    return ContentUris.withAppendedId(key.video ? MediaStore.Video.Media.getContentUri(key.volume)
                                                : MediaStore.Images.Media.getContentUri(key.volume),
        key.id);
  }
  private String thumbnail(MediaLibraryKey key, int size) throws Exception {
    unlocked();
    CancellationSignal cancellation = new CancellationSignal();
    Runnable timeout = cancellation::cancel;
    main.postDelayed(timeout, 3000);
    try {
      Bitmap bitmap = resolver.loadThumbnail(uri(key), new Size(size, size), cancellation);
      try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 80, bytes))
          throw new IllegalStateException();
        return "data:image/jpeg;base64,"
            + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
      } finally {
        bitmap.recycle();
      }
    } finally {
      main.removeCallbacks(timeout);
    }
  }
  private boolean readable(boolean video) {
    return !"denied".equals(access().getString(video ? "videos" : "images"));
  }
  private Cursor query(String volume, boolean video, Bundle args) {
    return query(volume, video, args, fields(video));
  }
  private Cursor query(String volume, boolean video, Bundle args, String[] projection) {
    unlocked();
    if (!readable(video))
      throw new SecurityException("Media access was revoked");
    CancellationSignal cancellation = new CancellationSignal();
    Runnable timeout = cancellation::cancel;
    main.postDelayed(timeout, 3000);
    try {
      if (PhotoLibraryAccess.OWNED.equals(access().getString(video ? "videos" : "images")))
        args = ownedOnly(args);
      // Typed collections are required for other apps' media under scoped storage.
      Uri collection = video ? MediaStore.Video.Media.getContentUri(volume)
                             : MediaStore.Images.Media.getContentUri(volume);
      Cursor cursor = resolver.query(collection, projection, args, cancellation);
      if (cursor == null)
        throw new IllegalStateException("Media provider unavailable");
      return new android.database.CursorWrapper(cursor) {
        @Override
        public void close() {
          try {
            super.close();
          } finally {
            main.removeCallbacks(timeout);
          }
        }
      };
    } catch (RuntimeException failure) {
      main.removeCallbacks(timeout);
      throw failure;
    }
  }
  /**
   * {@code args} narrowed to this app's own rows. Scoped storage already hides other apps' media
   * without a grant; the explicit filter keeps the {@code owned} answer true under legacy storage.
   */
  private Bundle ownedOnly(Bundle args) {
    Bundle out = new Bundle(args);
    String where = args.getString(ContentResolver.QUERY_ARG_SQL_SELECTION);
    String[] values = args.getStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS);
    List<String> all = new ArrayList<>();
    if (values != null) all.addAll(java.util.Arrays.asList(values));
    all.add(context.getPackageName());
    out.putString(ContentResolver.QUERY_ARG_SQL_SELECTION,
        (where == null || where.isEmpty() ? "" : "(" + where + ") AND ") + "owner_package_name=?");
    out.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, all.toArray(new String[0]));
    return out;
  }
  /** Provider search, not an in-memory scan of previously loaded thumbnails. */
  public JSObject list(String cursor, String search, String kind, boolean thumbnails)
      throws Exception {
    return list(cursor, search, kind, thumbnails, "all");
  }
  public JSObject list(String cursor, String search, String kind, boolean thumbnails, String filter)
      throws Exception {
    return list(cursor, search, kind, thumbnails, filter, 0, Long.MAX_VALUE, PAGE_SIZE);
  }
  public JSObject list(String cursor, String search, String kind, boolean thumbnails, String filter,
      long from, long to, int limit) throws Exception {
    if (from < 0 || to < from || limit < 1 || limit > PAGE_SIZE)
      throw new IllegalArgumentException("Invalid bounded media query");
    if (filter == null || !filter.matches("all|favorites|trash|camera|screenshots")
        || (Build.VERSION.SDK_INT < 30 && !filter.matches("all|camera|screenshots")))
      throw new IllegalArgumentException("Unsupported media filter");
    String pageKind = kind + ":" + filter + ":" + from + ":" + to + ":" + limit;
    if (search == null || search.length() > 128 || search.indexOf('\0') >= 0 || kind == null
        || !kind.matches("all|image|video"))
      throw new IllegalArgumentException("Invalid photo query");
    List<String> volumes = volumes();
    String snapshot = snapshot(volumes);
    boolean images = readable(false) && !kind.equals("video");
    boolean videos = readable(true) && !kind.equals("image");
    Page last = null;
    if (cursor != null && !cursor.isEmpty()) {
      synchronized (pages) {
        last = pages.remove(cursor);
      }
      if (last == null || last.until < SystemClock.elapsedRealtime()
          || !last.snapshot.equals(snapshot) || !last.query.equals(search)
          || !last.kind.equals(pageKind))
        throw new StaleCursor();
    }
    JSArray items = new JSArray();
    String next = "";
    long thumbnailUntil = SystemClock.elapsedRealtime() + 3000;
    // One newest-first catalog across every volume and both typed collections: each source
    // (volume x images/videos) is read below the previous page's last key, and the sources are
    // merged on (capture time desc, source, _id desc). The cursor is that key, so a later page never
    // inserts rows above ones already listed, and favorite or restore never reorders a page.
    List<Object[]> merged = new ArrayList<>();
    for (int volumeIndex = 0; volumeIndex < volumes.size(); volumeIndex++) {
      String volume = volumes.get(volumeIndex);
      for (boolean video : new boolean[] {false, true}) {
        if (video ? !videos : !images)
          continue;
        int source = volumeIndex * 2 + (video ? 1 : 0);
        Bundle args = new Bundle();
        List<String> values = new ArrayList<>();
        String where = "is_pending=0"
            + (Build.VERSION.SDK_INT >= 30
                    ? " AND is_trashed=" + (filter.equals("trash") ? "1" : "0")
                    : "")
            + (filter.equals("favorites") ? " AND is_favorite=1" : "")
            + OwnedMediaSelection.folderSelection(filter);
        if (last != null)
          where += after(source, last.shot, last.source, last.id, values);
        if (Build.VERSION.SDK_INT >= 30)
          args.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED,
              filter.equals("trash") ? MediaStore.MATCH_ONLY : MediaStore.MATCH_EXCLUDE);
        if (from > 0) {
          where += " AND date_added>=?";
          values.add(Long.toString(from / 1000 + (from % 1000 == 0 ? 0 : 1)));
        }
        if (to < Long.MAX_VALUE) {
          where += " AND date_added<=?";
          values.add(Long.toString(to / 1000));
        }
        if (!search.isBlank()) {
          where += " AND instr(lower(" + MediaStore.MediaColumns.DISPLAY_NAME + "),lower(?))>0";
          values.add(search.trim());
        }
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, where);
        args.putStringArray(
            ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, values.toArray(new String[0]));
        args.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, SHOT + " DESC, _id DESC");
        args.putInt(ContentResolver.QUERY_ARG_LIMIT, limit + 1);
        try (Cursor rows = query(volume, video, args)) {
          if (rows == null)
            throw new IllegalStateException("Media provider unavailable");
          while (rows.moveToNext())
            merged.add(new Object[] {shot(rows), source, rows.getLong(0), metadata(rows, volume, video)});
        }
      }
    }
    merged.sort(CATALOG_ORDER);
    for (Object[] row : merged) {
      if (items.length() == limit) {
        // The key of the last listed row; the next page continues strictly after it.
        Object[] key = merged.get(limit - 1);
        next = UUID.randomUUID().toString();
        synchronized (pages) {
          pages.entrySet().removeIf(
              entry -> entry.getValue().until < SystemClock.elapsedRealtime());
          while (pages.size() >= 32) pages.remove(pages.keySet().iterator().next());
          pages.put(next, new Page(snapshot, search, pageKind, (Long) key[0], (Integer) key[1], (Long) key[2]));
        }
        break;
      }
      JSObject item = (JSObject) row[3];
      if (thumbnails && SystemClock.elapsedRealtime() < thumbnailUntil) {
        try {
          item.put("image", thumbnail(MediaLibraryKey.parse(item.getString("id")), 240));
        } catch (Exception unavailable) {
          item.put("image", "");
        }
      }
      items.put(item);
    }
    current(snapshot, volumes);
    JSObject result = new JSObject();
    result.put("items", items);
    result.put("next", next);
    result.put("access", access());
    return result;
  }
  public JSObject read(String id, String expectedRevision, boolean pixels) throws Exception {
    return read(id, expectedRevision, pixels, false);
  }
  public JSObject read(String id, String expectedRevision, boolean pixels, boolean trashed)
      throws Exception {
    return read(id, expectedRevision, pixels, trashed, 1024);
  }
  /** As {@link #read(String, String, boolean, boolean)} with a preview of at most {@code edge}. */
  public JSObject read(String id, String expectedRevision, boolean pixels, boolean trashed,
      int edge) throws Exception {
    if (edge < PREVIEW_MIN || edge > PREVIEW_MAX)
      throw new IllegalArgumentException("Invalid preview size");
    MediaLibraryKey key = MediaLibraryKey.parse(id);
    List<String> volumes = volumes();
    String snapshot = snapshot(volumes);
    if (!volumes.contains(key.volume))
      throw new IllegalArgumentException("Media volume unavailable");
    JSObject result = inspect(key, trashed);
    if (trashed && !Boolean.TRUE.equals(result.getBoolean("trashed")))
      throw new IllegalStateException("Selected media is no longer deleted");
    String revision = result.getString("revision");
    if (expectedRevision != null && !expectedRevision.equals(revision))
      throw new IllegalStateException("Selected media changed");
    if (pixels)
      result.put("image", thumbnail(key, edge));
    if (!revision.equals(inspect(key, trashed).getString("revision")))
      throw new IllegalStateException("Selected media changed");
    current(snapshot, volumes);
    return result;
  }
  private JSObject inspect(MediaLibraryKey key) {
    return inspect(key, false);
  }
  private JSObject inspect(MediaLibraryKey key, boolean includeTrash) {
    unlocked();
    Bundle args = new Bundle();
    args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION,
        "_id=? AND is_pending=0"
            + (Build.VERSION.SDK_INT >= 30 && !includeTrash ? " AND is_trashed=0" : ""));
    if (Build.VERSION.SDK_INT >= 30)
      args.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED,
          includeTrash ? MediaStore.MATCH_INCLUDE : MediaStore.MATCH_EXCLUDE);
    args.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] {Long.toString(key.id)});
    try (Cursor row = query(key.volume, key.video, args)) {
      if (row == null || !row.moveToFirst())
        throw new SecurityException("Selected media is unavailable");
      return metadata(row, key.volume, key.video);
    }
  }
  /**
   * Metadata for many album members with one provider query per volume and media type instead of a
   * fenced read per member. Members that are missing, trashed, unreadable or whose identity changed
   * are omitted (membership is retained by the caller). The caller's Fence covers consistency.
   */
  public Map<String, JSObject> albumItems(List<String[]> members) throws Exception {
    unlocked();
    List<String> volumes = volumes();
    Map<String, Map<Long, String[]>> groups = new LinkedHashMap<>();
    for (String[] member : members) {
      MediaLibraryKey key;
      try {
        key = MediaLibraryKey.parse(member[0]);
      } catch (RuntimeException invalid) {
        continue;
      }
      if (!volumes.contains(key.volume))
        continue;
      groups.computeIfAbsent(key.volume + "|" + key.video, group -> new LinkedHashMap<>())
          .put(key.id, member);
    }
    Map<String, JSObject> result = new HashMap<>();
    for (Map.Entry<String, Map<Long, String[]>> group : groups.entrySet()) {
      MediaLibraryKey first = MediaLibraryKey.parse(group.getValue().values().iterator().next()[0]);
      StringBuilder selection = new StringBuilder("is_pending=0"
          + (Build.VERSION.SDK_INT >= 30 ? " AND is_trashed=0" : "") + " AND _id IN (");
      String[] args = new String[group.getValue().size()];
      int n = 0;
      for (Long id : group.getValue().keySet()) {
        if (n > 0)
          selection.append(',');
        selection.append('?');
        args[n++] = Long.toString(id);
      }
      selection.append(')');
      Bundle query = new Bundle();
      query.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection.toString());
      query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
      if (Build.VERSION.SDK_INT >= 30)
        query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_EXCLUDE);
      try (Cursor rows = query(first.volume, first.video, query)) {
        while (rows.moveToNext()) {
          String[] member = group.getValue().get(rows.getLong(0));
          if (member == null)
            continue;
          JSObject row = metadata(rows, first.volume, first.video);
          if (member[1].equals(row.getString("identity")))
            result.put(member[0], row);
        }
      } catch (SecurityException
              revoked) { /* This media type is no longer readable: withhold its members. */
      }
    }
    return result;
  }
  public JSObject albumItem(String id, String identity, boolean pixels) throws Exception {
    JSObject row = read(id, null, false);
    if (!identity.equals(row.getString("identity")))
      throw new IllegalStateException("Media identity changed");
    if (pixels) {
      row.put("image", thumbnail(MediaLibraryKey.parse(id), 240));
      if (!row.getString("revision").equals(read(id, null, false).getString("revision")))
        throw new IllegalStateException("Media changed");
    }
    return row;
  }
  public JSObject summary() throws Exception {
    List<String> volumes = volumes();
    String snapshot = snapshot(volumes);
    long until = SystemClock.elapsedRealtime() + 3000;
    int favorites = 0, videos = 0, trash = 0, camera = 0, screenshots = 0;
    for (String volume : volumes)
      for (boolean video : new boolean[] {false, true}) {
        if (!readable(video))
          continue;
        Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "is_pending=0");
        if (Build.VERSION.SDK_INT >= 30)
          args.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
        String[] projection = Build.VERSION.SDK_INT >= 30
            ? new String[] {"is_favorite", "is_trashed", MediaStore.MediaColumns.RELATIVE_PATH}
            : new String[] {"_id", MediaStore.MediaColumns.RELATIVE_PATH};
        try (Cursor rows = query(volume, video, args, projection)) {
          if (rows == null)
            throw new IllegalStateException("Media provider unavailable");
          while (rows.moveToNext()) {
            if (SystemClock.elapsedRealtime() > until)
              throw new IllegalStateException("Media count took too long");
            if (Build.VERSION.SDK_INT >= 30 && rows.getInt(1) == 1) {
              trash++;
              continue;
            }
            if (video)
              videos++;
            if (Build.VERSION.SDK_INT >= 30 && rows.getInt(0) == 1)
              favorites++;
            String album = OwnedMediaSelection.folderAlbum(rows.getString(projection.length - 1));
            if (album.equals("camera"))
              camera++;
            else if (album.equals("screenshots"))
              screenshots++;
          }
        }
      }
    current(snapshot, volumes);
    JSObject result = new JSObject();
    result.put("favorites", favorites);
    result.put("videos", videos);
    result.put("camera", camera);
    result.put("screenshots", screenshots);
    result.put("trash", trash);
    result.put("canFavorite", Build.VERSION.SDK_INT >= 30);
    return result;
  }
  /** No UI approval here: the caller must hold the one-shot reviewed operation. */
  public JSObject mutationSource(String id, String expected) throws Exception {
    if (Build.VERSION.SDK_INT < 30 || expected == null || expected.isEmpty()
        || expected.length() > 256)
      throw new IllegalArgumentException("Invalid media revision");
    MediaLibraryKey key = MediaLibraryKey.parse(id);
    if (!volumes().contains(key.volume))
      throw new SecurityException("Media volume unavailable");
    JSObject row = inspect(key, true);
    if (!expected.equals(row.getString("mutationRevision")))
      throw new IllegalStateException("stale");
    return row;
  }
  public JSObject changeFlag(String id, String expected, boolean favorite, boolean desired)
      throws Exception {
    if (Build.VERSION.SDK_INT < 30)
      throw new UnsupportedOperationException("Reviewed media changes require Android 11 or later");
    JSObject before = mutationSource(id, expected);
    MediaLibraryKey key = MediaLibraryKey.parse(id);
    if (favorite && Boolean.TRUE.equals(before.getBoolean("trashed")))
      throw new IllegalStateException("stale");
    if (Boolean.TRUE.equals(before.getBoolean(favorite ? "favorite" : "trashed")) == desired) {
      before.put("status", "unchanged");
      return before;
    }
    // Query and update use the same typed, volume-specific row. Generation is the
    // final atomic fence: approval grants access, not permission to change newer bytes.
    Bundle read = new Bundle();
    read.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
    read.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "_id=? AND is_pending=0");
    read.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] {Long.toString(key.id)});
    long generation, added;
    try (Cursor row = query(key.volume, key.video, read)) {
      if (row == null || !row.moveToFirst() || !expected.equals(revision(row, key.volume)))
        throw new IllegalStateException("stale");
      generation = row.getLong(9);
      added = row.getLong(8);
    }
    unlocked();
    String column = favorite ? "is_favorite" : "is_trashed";
    Bundle update = new Bundle(read);
    update.putString(ContentResolver.QUERY_ARG_SQL_SELECTION,
        "_id=? AND is_pending=0 AND generation_modified=? AND generation_added=? AND " + column
            + "=?" + (favorite ? " AND is_trashed=0" : ""));
    update.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
        new String[] {Long.toString(key.id), Long.toString(generation), Long.toString(added),
            desired ? "0" : "1"});
    android.content.ContentValues values = new android.content.ContentValues();
    values.put(column, desired ? 1 : 0);
    if (resolver.update(uri(key), values, update) != 1)
      throw new IllegalStateException("stale");
    JSObject after = inspect(key, true);
    if (Boolean.TRUE.equals(after.getBoolean(favorite ? "favorite" : "trashed")) != desired
        || !before.getString("identity").equals(after.getString("identity")))
      throw new IllegalStateException("unverified");
    after.put("status",
        favorite ? (desired ? "favorited" : "unfavorited") : (desired ? "trashed" : "restored"));
    invalidate();
    return after;
  }
  /** Permanent removal is restricted to an explicitly reviewed deleted revision. */
  public JSObject deleteTrashed(String id, String expected) throws Exception {
    if (Build.VERSION.SDK_INT < 30)
      throw new UnsupportedOperationException(
          "Reviewed media removal requires Android 11 or later");
    JSObject before = mutationSource(id, expected);
    if (!Boolean.TRUE.equals(before.getBoolean("trashed")))
      throw new IllegalStateException("stale");
    MediaLibraryKey key = MediaLibraryKey.parse(id);
    Bundle query = new Bundle();
    query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_ONLY);
    query.putString(
        ContentResolver.QUERY_ARG_SQL_SELECTION, "_id=? AND is_pending=0 AND is_trashed=1");
    query.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] {Long.toString(key.id)});
    long generation, added;
    try (Cursor row = query(key.volume, key.video, query)) {
      if (row == null || !row.moveToFirst() || !expected.equals(revision(row, key.volume)))
        throw new IllegalStateException("stale");
      generation = row.getLong(9);
      added = row.getLong(8);
    }
    unlocked();
    Bundle removal = new Bundle(query);
    removal.putString(ContentResolver.QUERY_ARG_SQL_SELECTION,
        "_id=? AND is_pending=0 AND is_trashed=1 AND generation_modified=? AND generation_added=?");
    removal.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
        new String[] {Long.toString(key.id), Long.toString(generation), Long.toString(added)});
    if (resolver.delete(uri(key), removal) != 1)
      throw new IllegalStateException("stale");
    Bundle absence = new Bundle();
    absence.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE);
    absence.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "_id=?");
    absence.putStringArray(
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] {Long.toString(key.id)});
    try (Cursor row = query(key.volume, key.video, absence)) {
      if (row == null || row.moveToFirst())
        throw new IllegalStateException("unverified");
    }
    invalidate();
    JSObject result = new JSObject();
    result.put("id", id);
    result.put("status", "deleted");
    return result;
  }
  @Override
  public void close() {
    synchronized (this) {
      closed = true;
      watchers.clear();
    }
    invalidate();
    watch(false);
    context.unregisterReceiver(screenOff);
  }
}
