package ai.eliza.plugins.media;
import android.content.*;
import android.database.Cursor;
import android.graphics.*;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.*;
import java.util.UUID;
import org.json.JSONObject;

/**
 * Serial-worker edit sessions over the host's own published still photos. No arbitrary URIs or
 * uploads: an edit is a new owned PNG copy with a crash-safe receipt journal, or, only when the
 * person chose Replace, the same edit written over the reviewed original ({@link #replace}). The
 * host supplies storage namespace and MediaStore placement through {@link OwnedMediaConfig}.
 */
public final class OwnedPhotoEdits {
  private final Context context;
  private final ContentResolver resolver;
  private final SharedPreferences journal;
  private final OwnedMediaConfig config;
  /** Optional host-validated source. It never changes the owned copy destination. */
  public interface SourceAccess {
    boolean accepts(String id);
    Uri source(String id) throws Exception;
    String revision(String id) throws Exception;
  }
  private final SourceAccess sourceAccess;
  /**
   * Opens the original for Replace's truncating write. The default asks the ContentResolver; a
   * host test may wrap the stream to inject a failed write.
   */
  public interface ReplaceOutput {
    OutputStream open(ContentResolver resolver, Uri target) throws IOException;
  }
  private static final ReplaceOutput RESOLVER_OUTPUT = (r, target) -> r.openOutputStream(target, "wt");
  private final ReplaceOutput replaceOutput;
  private volatile Session active;
  private static final int MAX_EDGE = 2048;
  /** A replaced original keeps up to this many pixels (16 MP); larger originals are reduced. */
  private static final long REPLACE_PIXELS = 16L * 1024 * 1024;
  /** Capture metadata a replaced JPEG keeps. Orientation is not copied: the pixels are upright. */
  private static final String[] KEPT_EXIF = {android.media.ExifInterface.TAG_DATETIME,
      android.media.ExifInterface.TAG_DATETIME_ORIGINAL,
      android.media.ExifInterface.TAG_DATETIME_DIGITIZED,
      android.media.ExifInterface.TAG_OFFSET_TIME,
      android.media.ExifInterface.TAG_OFFSET_TIME_ORIGINAL,
      android.media.ExifInterface.TAG_OFFSET_TIME_DIGITIZED,
      android.media.ExifInterface.TAG_SUBSEC_TIME,
      android.media.ExifInterface.TAG_SUBSEC_TIME_ORIGINAL,
      android.media.ExifInterface.TAG_SUBSEC_TIME_DIGITIZED, android.media.ExifInterface.TAG_MAKE,
      android.media.ExifInterface.TAG_MODEL, android.media.ExifInterface.TAG_F_NUMBER,
      android.media.ExifInterface.TAG_EXPOSURE_TIME,
      android.media.ExifInterface.TAG_ISO_SPEED_RATINGS,
      android.media.ExifInterface.TAG_FOCAL_LENGTH, android.media.ExifInterface.TAG_FLASH,
      android.media.ExifInterface.TAG_WHITE_BALANCE, android.media.ExifInterface.TAG_GPS_LATITUDE,
      android.media.ExifInterface.TAG_GPS_LATITUDE_REF,
      android.media.ExifInterface.TAG_GPS_LONGITUDE,
      android.media.ExifInterface.TAG_GPS_LONGITUDE_REF,
      android.media.ExifInterface.TAG_GPS_ALTITUDE,
      android.media.ExifInterface.TAG_GPS_ALTITUDE_REF,
      android.media.ExifInterface.TAG_GPS_TIMESTAMP, android.media.ExifInterface.TAG_GPS_DATESTAMP,
      android.media.ExifInterface.TAG_IMAGE_DESCRIPTION, android.media.ExifInterface.TAG_ARTIST,
      android.media.ExifInterface.TAG_COPYRIGHT};
  private static final class Session {
    String token, id, revision, mime;
    byte[] digest;
    Bitmap pixels;
    volatile boolean cancelled;
    boolean reduced, owned;
  }
  public OwnedPhotoEdits(Context c, OwnedMediaConfig config) {
    this(c, config, null);
  }
  public OwnedPhotoEdits(Context c, OwnedMediaConfig config, SourceAccess sourceAccess) {
    this(c, config, sourceAccess, null);
  }
  public OwnedPhotoEdits(Context c, OwnedMediaConfig config, SourceAccess sourceAccess,
      ReplaceOutput replaceOutput) {
    this.sourceAccess = sourceAccess;
    this.replaceOutput = replaceOutput == null ? RESOLVER_OUTPUT : replaceOutput;
    context = c;
    this.config = config;
    resolver = c.getContentResolver();
    journal = c.getSharedPreferences(config.preferences("photo-edit-results"), 0);
    sweepSettledBackups();
  }
  private static final java.util.Set<String> SWEPT =
      java.util.Collections.synchronizedSet(new java.util.HashSet<>());
  /** Reclaims only verified backups of durable terminal receipts. Unknown records retain bytes. */
  private void sweepSettledBackups() {
    File directory = new File(context.getFilesDir(), "photo-replace-backups");
    if (!SWEPT.add(directory.getAbsolutePath())) return;
    File[] files = directory.listFiles();
    if (files == null) return;
    for (File file : files) {
      String name = file.getName();
      int dot = name.lastIndexOf('.');
      if (dot <= 0) continue;
      String suffix = name.substring(dot + 1);
      if (!suffix.equals("original") && !suffix.equals("edited")) continue;
      try {
        String text = journal.getString(name.substring(0, dot), null);
        if (text == null) continue;
        JSONObject record = new JSONObject(text);
        String status = record.optString("status");
        if (!status.equals("saved") && !status.equals("failed")) continue;
        discardBackup(file, record.optString(suffix.equals("original") ? "original" : "edited"));
      } catch (Exception unreadable) {
        // An unreadable receipt cannot authorize deleting a backup.
      }
    }
  }
  private Uri source(String id) throws Exception {
    if (sourceAccess != null && sourceAccess.accepts(id)) return sourceAccess.source(id);
    if (id == null || !id.matches("[1-9][0-9]*"))
      throw new IllegalArgumentException("Only saved still photos can be edited");
    return ContentUris.withAppendedId(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, Long.parseLong(id));
  }
  private String revision(String id) throws Exception {
    if (sourceAccess != null && sourceAccess.accepts(id)) return sourceAccess.revision(id);
    String[] fields = Build.VERSION.SDK_INT >= 30
        ? new String[] {"date_added", "_size", "generation_modified", "is_trashed"}
        : new String[] {"date_added", "_size"};
    try (Cursor row = resolver.query(source(id), fields,
             "owner_package_name=? AND is_pending=0"
                 + (Build.VERSION.SDK_INT >= 30 ? " AND is_trashed=0" : ""),
             new String[] {context.getPackageName()}, null)) {
      if (row == null || !row.moveToFirst())
        throw new IllegalArgumentException("Photo no longer available. Reload Photos.");
      if (row.getLong(1) > 32L * 1024 * 1024)
        throw new IllegalArgumentException("Edit copies support source files up to 32 MB");
      return row.getLong(0) + ":" + row.getLong(1)
          + (Build.VERSION.SDK_INT >= 30 ? ":" + row.getLong(2) + ":" + row.getInt(3) : "");
    }
  }
  private byte[] bytes(String id) throws Exception {
    try (InputStream input = resolver.openInputStream(source(id));
        ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      if (input == null)
        throw new IOException();
      byte[] chunk = new byte[16384];
      int n;
      while ((n = input.read(chunk)) != -1) {
        if (output.size() + n > 32 * 1024 * 1024)
          throw new IllegalArgumentException("Edit copies support source files up to 32 MB");
        output.write(chunk, 0, n);
      }
      return output.toByteArray();
    }
  }
  private byte[] digest(String id) throws Exception {
    java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
    try (InputStream input = resolver.openInputStream(source(id))) {
      if (input == null)
        throw new IOException();
      byte[] buffer = new byte[16384];
      int n, total = 0;
      while ((n = input.read(buffer)) != -1) {
        total += n;
        if (total > 32 * 1024 * 1024)
          throw new IOException();
        hash.update(buffer, 0, n);
      }
    }
    return hash.digest();
  }
  private void current(Session s) throws Exception {
    if (s == null || s.cancelled || active != s)
      throw new IllegalArgumentException("Photo editor closed");
    if (!s.revision.equals(revision(s.id)) || !java.util.Arrays.equals(s.digest, digest(s.id)))
      throw new IllegalArgumentException("Photo changed. Cancel and reopen the editor.");
  }
  public JSObject begin(String id, String expected) throws Exception {
    close();
    String before = revision(id);
    if (expected == null || !expected.equals(before))
      throw new IllegalArgumentException("Photo changed. Reload Photos.");
    Session s = new Session();
    s.id = id;
    s.revision = before;
    s.token = UUID.randomUUID().toString();
    byte[] snapshot = bytes(id);
    s.digest = java.security.MessageDigest.getInstance("SHA-256").digest(snapshot);
    Bitmap pixels = ImageDecoder.decodeBitmap(
        ImageDecoder.createSource(java.nio.ByteBuffer.wrap(snapshot)), (decoder, info, src) -> {
          if (info.isAnimated())
            throw new IllegalArgumentException("Animated images cannot be edited here");
          int width = info.getSize().getWidth(), height = info.getSize().getHeight();
          double scale = Math.min(1d, MAX_EDGE / (double) Math.max(width, height));
          s.reduced = scale < 1;
          decoder.setTargetSize(Math.max(1, (int) Math.round(width * scale)),
              Math.max(1, (int) Math.round(height * scale)));
          decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
          decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB));
        });
    s.pixels = pixels;
    active = s;
    try {
      describe(s);
      current(s);
      JSObject value = preview(s.token, 0, false, "none");
      value.put("canReplace", canReplace(s));
      return value;
    } catch (Exception error) {
      close();
      throw error;
    }
  }
  private Session session(String token) throws Exception {
    Session s = active;
    if (s == null || !s.token.equals(token))
      throw new IllegalArgumentException("Photo edit session expired");
    current(s);
    return s;
  }
  private Bitmap geometry(Bitmap pixels, int rotation, PhotoCrop crop) {
    if (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270)
      throw new IllegalArgumentException("Use a quarter-turn rotation");
    Matrix matrix = new Matrix();
    matrix.postRotate(rotation);
    Bitmap rotated =
        Bitmap.createBitmap(pixels, 0, 0, pixels.getWidth(), pixels.getHeight(), matrix, false);
    if (!crop.enabled())
      return rotated;
    int[] kept = crop.pixels(rotated.getWidth(), rotated.getHeight());
    Bitmap result = Bitmap.createBitmap(rotated, kept[0], kept[1], kept[2], kept[3]);
    if (rotated != pixels && rotated != result)
      rotated.recycle();
    return result;
  }
  private Bitmap transform(Session s, int rotation, PhotoCrop crop, String filter) {
    return transform(s, s.pixels, rotation, crop, filter);
  }
  private Bitmap transform(Session s, Bitmap pixels, int rotation, PhotoCrop crop, String filter) {
    Bitmap geometry = geometry(pixels, rotation, crop);
    try {
      Bitmap output = PhotoFilter.apply(geometry, filter, () -> s.cancelled);
      if (output != geometry && geometry != pixels)
        geometry.recycle();
      return output;
    } catch (RuntimeException e) {
      if (geometry != pixels)
        geometry.recycle();
      throw e;
    }
  }
  public JSObject preview(String token, int rotation, boolean crop, String filter)
      throws Exception {
    return preview(token, rotation, PhotoCrop.of(crop), filter);
  }
  /** A preview that keeps {@code crop} of the rotated photo. */
  public JSObject preview(String token, int rotation, PhotoCrop crop, String filter)
      throws Exception {
    Session s = session(token);
    Bitmap bitmap = transform(s, rotation, crop, filter), small = bitmap;
    try {
      double scale = Math.min(1d, 1024d / Math.max(bitmap.getWidth(), bitmap.getHeight()));
      if (scale < 1)
        small = Bitmap.createScaledBitmap(bitmap, Math.max(1, (int) (bitmap.getWidth() * scale)),
            Math.max(1, (int) (bitmap.getHeight() * scale)), true);
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      if (!small.compress(Bitmap.CompressFormat.PNG, 100, out))
        throw new IOException();
      current(s);
      JSObject value = new JSObject();
      value.put("sessionId", token);
      value.put("operationId", token);
      value.put("image",
          "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
      value.put("width", bitmap.getWidth());
      value.put("height", bitmap.getHeight());
      value.put("reduced", s.reduced);
      value.put("maxEdge", MAX_EDGE);
      value.put("filter", filter);
      return value;
    } finally {
      if (small != bitmap && small != s.pixels)
        small.recycle();
      if (bitmap != s.pixels)
        bitmap.recycle();
    }
  }
  private String name(String token) {
    return config.editName(token);
  }
  private JSObject receipt(String status, String token, Uri uri) {
    JSObject out = new JSObject();
    out.put("status", status);
    out.put("operationId", token);
    if (uri != null)
      out.put("id", Long.toString(ContentUris.parseId(uri)));
    return out;
  }
  public JSObject result(String token) throws Exception {
    name(token);
    String record = journal.getString(token, null);
    if (record == null)
      return receipt("not-started", token, null);
    JSONObject saved = new JSONObject(record);
    if (saved.optBoolean("replace"))
      return replaceResult(token, saved);
    boolean published = saved.optString("status").equals("saved");
    String savedId = saved.optString("id", null);
    if (published && savedId != null)
      return receipt("saved", token, source(savedId));
    // Pending rows from an interrupted save must be visible to recovery as well as published copies.
    try (Cursor row = resolver.query(
             MediaStore.setIncludePending(MediaStore.Images.Media.EXTERNAL_CONTENT_URI),
             new String[] {"_id", "is_pending"}, "owner_package_name=? AND _display_name=?",
             new String[] {context.getPackageName(), name(token)}, null)) {
      if (row == null)
        throw new IOException("Saved-copy lookup is unavailable");
      if (row.moveToFirst()) {
        Uri copy = ContentUris.withAppendedId(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, row.getLong(0));
        if (row.moveToNext())
          throw new IllegalStateException("Ambiguous saved copy; inspect Photos before retrying");
        row.moveToFirst();
        if (row.getInt(1) == 0) {
          saved.put("status", "saved").put("id", Long.toString(ContentUris.parseId(copy)));
          if (!journal.edit().putString(token, saved.toString()).commit())
            throw new IOException("Saved-copy receipt could not be persisted");
          return receipt("saved", token, copy);
        }
        // A previously confirmed save remains a historical success, even if its item changed.
        if (published)
          return receipt("saved", token, null);
        if (resolver.delete(MediaStore.setIncludePending(copy), "is_pending=1", null) != 1)
          throw new IOException("Pending copy cleanup was not confirmed");
        saved.put("status", "failed");
        if (!journal.edit().putString(token, saved.toString()).commit())
          throw new IOException();
        return receipt("failed", token, null);
      }
    }
    if (published)
      return receipt("saved", token, null);
    saved.put("status", "failed");
    if (!journal.edit().putString(token, saved.toString()).commit())
      throw new IOException();
    return receipt("failed", token, null);
  }
  public JSObject save(String token, int rotation, boolean crop, String filter) throws Exception {
    return save(token, rotation, PhotoCrop.of(crop), filter);
  }
  /** A saved record names the same crop: the same flag and the same chosen rectangle, if any. */
  private static boolean sameCrop(JSONObject previous, PhotoCrop crop) throws org.json.JSONException {
    return previous.getBoolean("crop") == crop.enabled()
        && previous.optString("cropRect", "").equals(crop.rectKey());
  }
  private static JSONObject putCrop(JSONObject record, PhotoCrop crop) throws org.json.JSONException {
    record.put("crop", crop.enabled());
    if (!crop.rectKey().isEmpty())
      record.put("cropRect", crop.rectKey());
    return record;
  }
  /** {@link #save(String, int, boolean, String)} keeping {@code crop} of the rotated photo. */
  public JSObject save(String token, int rotation, PhotoCrop crop, String filter) throws Exception {
    PhotoFilter.validate(filter);
    Session s = session(token);
    String existing = journal.getString(token, null);
    if (existing != null) {
      JSONObject previous = new JSONObject(existing);
      if (previous.optBoolean("replace") || previous.getInt("rotation") != rotation
          || !sameCrop(previous, crop)
          || !previous.optString("filter", "none").equals(filter))
        throw new IllegalArgumentException("This save identity already has a different edit");
      return result(token);
    }
    if (rotation == 0 && !crop.enabled() && filter.equals("none"))
      return receipt("unchanged", token, null);
    JSONObject saveReceipt = putCrop(new JSONObject()
                                         .put("status", "incomplete")
                                         .put("createdAt", System.currentTimeMillis())
                                         .put("rotation", rotation)
                                         .put("filter", filter),
        crop);
    if (!journal.edit().putString(token, saveReceipt.toString()).commit())
      throw new IOException("Save receipt could not be reserved");
    Bitmap bitmap = null;
    Uri copy = null;
    try {
      bitmap = transform(s, rotation, crop, filter);
      current(s);
      ContentValues values = new ContentValues();
      values.put(MediaStore.Images.Media.DISPLAY_NAME, name(token));
      values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
      values.put(MediaStore.Images.Media.RELATIVE_PATH, config.editRelativePath);
      values.put(MediaStore.Images.Media.IS_PENDING, 1);
      values.put(MediaStore.Images.Media.WIDTH, bitmap.getWidth());
      values.put(MediaStore.Images.Media.HEIGHT, bitmap.getHeight());
      copy = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
      if (copy == null)
        throw new IOException("Copy could not be created");
      try (OutputStream output = resolver.openOutputStream(copy, "w")) {
        if (output == null || !bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
          throw new IOException("Copy could not be written");
        output.flush();
      }
      current(s);
      values = new ContentValues();
      values.put(MediaStore.Images.Media.IS_PENDING, 0);
      if (resolver.update(copy, values, null, null) != 1)
        throw new IOException("Copy publication was not confirmed");
      // Never delete a published copy merely because its receipt write failed.
      saveReceipt.put("status", "saved").put("id", Long.toString(ContentUris.parseId(copy)));
      journal.edit().putString(token, saveReceipt.toString()).commit();
      return receipt("saved", token, copy);
    } catch (Exception failure) {
      if (copy != null) {
        try (Cursor row = resolver.query(copy, new String[] {"is_pending"}, null, null, null)) {
          if (row != null && row.moveToFirst() && row.getInt(0) == 1)
            resolver.delete(copy, null, null);
        }
      }
      throw failure;
    } finally {
      if (bitmap != null && bitmap != s.pixels)
        bitmap.recycle();
    }
  }
  /** Owner package and type of the session's original, for {@link #canReplace}. */
  private void describe(Session s) throws Exception {
    try (Cursor row = resolver.query(source(s.id),
             new String[] {"owner_package_name", MediaStore.MediaColumns.MIME_TYPE}, null, null,
             null)) {
      if (row == null || !row.moveToFirst())
        throw new IllegalArgumentException("Photo no longer available. Reload Photos.");
      s.owned = context.getPackageName().equals(row.getString(0));
      s.mime = row.getString(1);
    }
  }
  /**
   * Whether Replace can write this original: a still JPEG, PNG or WebP (formats Android can encode
   * again), owned by this app or on Android 11+, where MediaStore can ask for write consent.
   */
  private static boolean canReplace(Session s) {
    return s.mime != null && s.mime.matches("image/(jpeg|png|webp)")
        && (s.owned || Build.VERSION.SDK_INT >= 30);
  }
  /** The open session named {@code token}, without the content check {@link #session} adds. */
  private Session open(String token) {
    Session s = active;
    if (s == null || !s.token.equals(token) || s.cancelled)
      throw new IllegalArgumentException("Photo edit session expired");
    return s;
  }
  /** Whether the original still has the revision and bytes the editor opened. */
  private boolean unchanged(Session s) {
    try {
      return s.revision.equals(revision(s.id)) && java.util.Arrays.equals(s.digest, digest(s.id));
    } catch (Exception changedOrGone) {
      return false;
    }
  }
  /**
   * The item a Replace overwrites, as {@code {id, revision}}, when Android must grant write access
   * first (another app's photo, without all-files access); null when this app may write it directly
   * or {@link #replace} answers without writing (a recorded result or a changed original).
   */
  public String[] replaceConsent(String token) throws Exception {
    name(token);
    if (journal.getString(token, null) != null)
      return null;
    Session s = open(token);
    if (!canReplace(s))
      throw new IllegalArgumentException("This photo can only be saved as a copy");
    if (s.owned || !unchanged(s)
        || Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager())
      return null;
    return new String[] {s.id, s.revision};
  }
  /**
   * Writes the edit over the original the editor opened, never over newer bytes: the original's
   * revision and SHA-256 must still be the reviewed ones before decoding and again just before the
   * write, else the answer is {@code stale} and nothing is written. The edit is applied to the
   * full-resolution original (up to {@link #REPLACE_PIXELS}), encoded in its own format to a
   * private file, and only then copied over the original with a truncating write. Before that write
   * the original's bytes are kept in a private backup named in the journal; a write that fails is
   * undone only when the damage can be tied to this operation. The next {@link #result} can
   * recognize either complete version or a partial write from the durable encoded edit. A restore
   * records its phase before writing, so a restart can also recover its original-byte prefix.
   * The backup is removed only once the original holds either the edit or its own bytes again. JPEG capture
   * metadata is kept; orientation is normal because the rotation is in the pixels. The receipt is
   * {@code {status: "saved", id, replaced: true, revision?}} with the original's id and, once
   * MediaStore has rescanned it, its new revision. The journal records the phases, so a later
   * {@link #result} reports {@code failed} (the original is unchanged), {@code stale},
   * {@code unknown} (the original could not be restored yet; the backup is kept and the next
   * {@link #result} tries again) or {@code saved}. Android's consent, when needed, is the
   * caller's ({@link #replaceConsent}).
   */
  public JSObject replace(String token, int rotation, boolean crop, String filter)
      throws Exception {
    return replace(token, rotation, PhotoCrop.of(crop), filter);
  }
  /** {@link #replace(String, int, boolean, String)} keeping {@code crop} of the rotated photo. */
  public JSObject replace(String token, int rotation, PhotoCrop crop, String filter)
      throws Exception {
    PhotoFilter.validate(filter);
    name(token);
    String existing = journal.getString(token, null);
    if (existing != null) {
      JSONObject previous = new JSONObject(existing);
      if (!previous.optBoolean("replace") || previous.getInt("rotation") != rotation
          || !sameCrop(previous, crop)
          || !previous.optString("filter", "none").equals(filter))
        throw new IllegalArgumentException("This save identity already has a different edit");
      return result(token);
    }
    Session s = open(token);
    if (!canReplace(s))
      throw new IllegalArgumentException("This photo can only be saved as a copy");
    if (rotation == 0 && !crop.enabled() && filter.equals("none"))
      return receipt("unchanged", token, null);
    if (!unchanged(s))
      return receipt("stale", token, null);
    JSONObject record = putCrop(new JSONObject()
                                    .put("status", "incomplete")
                                    .put("replace", true)
                                    .put("id", s.id)
                                    .put("createdAt", System.currentTimeMillis())
                                    .put("rotation", rotation)
                                    .put("filter", filter),
        crop);
    if (!journal.edit().putString(token, record.toString()).commit())
      throw new IOException("Save receipt could not be reserved");
    Bitmap full = null, edited = null;
    File staged = null;
    boolean opened = false, backupCreated = false, editBackupCreated = false;
    try {
      byte[] snapshot = bytes(s.id);
      if (!java.util.Arrays.equals(
              s.digest, java.security.MessageDigest.getInstance("SHA-256").digest(snapshot))
          || !s.revision.equals(revision(s.id)))
        return replaceStale(token, record);
      full = decodeFull(snapshot);
      edited = transform(s, full, rotation, crop, filter);
      staged = stage(edited, s.mime, snapshot);
      if (s.cancelled || active != s)
        throw new IllegalArgumentException("Photo editor closed");
      if (!unchanged(s))
        return replaceStale(token, record);
      // A durable copy of the original before it is truncated, named in the journal first.
      File kept = backup(token);
      Uri target = source(s.id);
      writeDurably(new ByteArrayInputStream(snapshot), kept);
      backupCreated = true;
      snapshot = null;
      File encoded = editBackup(token);
      try (InputStream input = new FileInputStream(staged)) {
        writeDurably(input, encoded);
      }
      editBackupCreated = true;
      record.put("backup", kept.getName())
          .put("editBackup", encoded.getName())
          .put("target", target.toString())
          .put("original", hex(s.digest))
          .put("edited", hex(fileDigest(staged)))
          .put("status", "writing");
      if (!journal.edit().putString(token, record.toString()).commit()) {
        kept.delete();
        encoded.delete();
        throw new IOException("Save receipt could not be persisted");
      }
      if (!unchanged(s) || !target.equals(source(s.id))) {
        record.remove("backup");
        record.remove("editBackup");
        kept.delete();
        encoded.delete();
        return replaceStale(token, record);
      }
      opened = true;
      try {
        copyOver(staged, target, token, record);
      } catch (Exception writeFailed) {
        // Put the original back from the backup; only then is this a plain failure. A write
        // that completed before the error (a failed close) is the saved edit.
        if (!settleReplace(token, record).equals("saved"))
          throw writeFailed;
      }
      // The original is written; a receipt write failure must not turn that into a failure.
      // Without the receipt the backup stays, and the next result settles the edit as saved.
      record.put("status", "saved");
      if (journal.edit().putString(token, record.toString()).commit()) {
        kept.delete();
        encoded.delete();
      }
      String revision = settled(s);
      if (revision != null) {
        record.put("revision", revision);
        journal.edit().putString(token, record.toString()).commit();
      }
      if (active == s)
        close();
      return replaced(token, s.id, revision);
    } catch (Exception failure) {
      // Before the original was opened for writing nothing was written to it.
      if (!opened && !"stale".equals(record.optString("status"))) {
        if (backupCreated) backup(token).delete();
        if (editBackupCreated) editBackup(token).delete();
        record.remove("backup");
        record.remove("editBackup");
        record.put("status", "failed");
        journal.edit().putString(token, record.toString()).commit();
      }
      throw failure;
    } finally {
      if (edited != null && edited != full)
        edited.recycle();
      if (full != null)
        full.recycle();
      if (staged != null)
        staged.delete();
    }
  }
  /** The private backup a Replace keeps of its original until the write is settled. */
  private File backup(String token) {
    return new File(new File(context.getFilesDir(), "photo-replace-backups"), token + ".original");
  }
  /** The encoded edit survives cache eviction and process death until the write is settled. */
  private File editBackup(String token) {
    return new File(new File(context.getFilesDir(), "photo-replace-backups"), token + ".edited");
  }
  private static boolean regularBackup(File file) throws IOException {
    return !java.nio.file.Files.isSymbolicLink(file.getParentFile().toPath())
        && !java.nio.file.Files.isSymbolicLink(file.toPath()) && file.isFile();
  }
  private static void writeDurably(InputStream input, File file) throws IOException {
    File parent = file.getParentFile();
    if (parent == null || java.nio.file.Files.isSymbolicLink(parent.toPath())
        || !parent.isDirectory() && !parent.mkdirs())
      throw new IOException("Original could not be kept");
    // A pre-existing backup is unproven. Never truncate it, including through a symlink.
    try (java.nio.channels.FileChannel output = java.nio.channels.FileChannel.open(file.toPath(),
             java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE,
             java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
      byte[] chunk = new byte[65536];
      int n;
      while ((n = input.read(chunk)) != -1) {
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(chunk, 0, n);
        while (buffer.hasRemaining()) output.write(buffer);
      }
      output.force(true);
    }
  }
  /** Copies {@code from} over {@code target} with a truncating, synced write. */
  private void copyOver(File from, Uri target, String token, JSONObject record) throws IOException {
    boolean opened = false;
    try (InputStream input = new FileInputStream(from);
        OutputStream output = replaceOutput.open(resolver, target)) {
      if (output == null)
        throw new IOException("Original could not be opened for writing");
      opened = true;
      byte[] chunk = new byte[65536];
      int n;
      while ((n = input.read(chunk)) != -1) output.write(chunk, 0, n);
      output.flush();
      if (output instanceof FileOutputStream)
        ((FileOutputStream) output).getFD().sync();
    } catch (IOException failure) {
      if (opened)
        rememberDamage(token, record, from);
      throw failure;
    }
  }
  private static byte[] fileDigest(File file) throws Exception {
    java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
    try (InputStream input = new FileInputStream(file)) {
      byte[] buffer = new byte[65536];
      int n;
      while ((n = input.read(buffer)) != -1) hash.update(buffer, 0, n);
    }
    return hash.digest();
  }
  private static String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    return out.toString();
  }
  /** Records a failed writer's exact incomplete output while that output is still observable. */
  private void rememberDamage(String token, JSONObject record, File attempted) {
    String id = record.optString("id");
    try {
      if (!source(id).toString().equals(record.optString("target")))
        return;
      byte[] current = bytes(id);
      if (current.length >= attempted.length())
        return;
      try (InputStream expected = new BufferedInputStream(new FileInputStream(attempted))) {
        for (byte value : current) {
          if (expected.read() != (value & 0xff))
            return;
        }
      }
      String hash = hex(java.security.MessageDigest.getInstance("SHA-256").digest(current));
      JSONObject updated = new JSONObject(record.toString());
      updated.put("damage", hash);
      if (journal.edit().putString(token, updated.toString()).commit())
        record.put("damage", hash);
    } catch (Exception unavailable) {
      // Unreadable or unconfirmed bytes are never authority to restore over the original.
    }
  }
  /**
   * Recognizes complete versions, recorded damage, or a prefix of the durable encoded edit.
   * An original prefix is recoverable only after a durable restore-start record. Unrelated bytes,
   * unreadable items and legacy interruptions without proof leave all backups kept.
   */
  private String settleReplace(String token, JSONObject record) throws Exception {
    String name = record.optString("backup", "");
    File kept = name.isEmpty() ? null : backup(token);
    if (kept == null || !kept.getName().equals(name) || !regularBackup(kept)
        || record.optString("original").isEmpty())
      return "writing";
    String id = record.getString("id"), now;
    byte[] current;
    Uri target;
    try {
      target = source(id);
      if (record.has("target") && !target.toString().equals(record.getString("target")))
        return "writing";
      revision(id);
      current = bytes(id);
      now = hex(java.security.MessageDigest.getInstance("SHA-256").digest(current));
    } catch (Exception unreadable) {
      return "writing";
    }
    String status;
    if (now.equals(record.optString("edited")))
      status = "saved";
    else if (now.equals(record.optString("original")))
      status = "failed";
    else {
      if (!target.toString().equals(record.optString("target")))
        return "writing";
      try {
        if (!hex(fileDigest(kept)).equals(record.optString("original")))
          return "writing";
        if (!now.equals(record.optString("damage"))) {
          File encoded = editBackup(token);
          if (!encoded.getName().equals(record.optString("editBackup"))
              || !regularBackup(encoded)
              || !hex(fileDigest(encoded)).equals(record.optString("edited"))
              || !(writtenPrefix(current, encoded)
                  || record.optBoolean("restoring") && writtenPrefix(current, kept)))
            return "writing";
        }
        // Persist the restore phase before truncation, including when a later restore crashes.
        record.put("restoring", true);
        if (!journal.edit().putString(token, record.toString()).commit())
          return "writing";
        // A MediaStore rescan can change the revision without changing the bytes we just wrote.
        revision(id);
        if (!now.equals(hex(digest(id))) || !target.equals(source(id)))
          return "writing";
        copyOver(kept, target, token, record);
        if (!hex(digest(id)).equals(record.optString("original")))
          return "writing";
      } catch (Exception notRestored) {
        return "writing";
      }
      status = "failed";
    }
    record.put("status", status);
    record.remove("backup");
    if (!journal.edit().putString(token, record.toString()).commit()) {
      record.put("status", "writing").put("backup", name);
      return "writing";
    }
    discardBackup(kept, record.optString("original"));
    File encoded = editBackup(token);
    if (encoded.getName().equals(record.optString("editBackup")))
      discardBackup(encoded, record.optString("edited"));
    return status;
  }
  private static void discardBackup(File file, String expected) {
    try {
      if (regularBackup(file) && hex(fileDigest(file)).equals(expected)) file.delete();
    } catch (Exception unavailable) {
      // A settled result is durable; unproven or unreadable backup bytes still stay intact.
    }
  }
  /** A strict prefix, never an unrelated or longer file. Empty means truncation before output. */
  private static boolean writtenPrefix(byte[] current, File attempted) throws IOException {
    if (current.length >= attempted.length()) return false;
    try (InputStream expected = new BufferedInputStream(new FileInputStream(attempted))) {
      for (byte value : current)
        if (expected.read() != (value & 0xff)) return false;
    }
    return true;
  }
  private JSObject replaceStale(String token, JSONObject record) throws Exception {
    record.put("status", "stale");
    journal.edit().putString(token, record.toString()).commit();
    return receipt("stale", token, null);
  }
  private JSObject replaced(String token, String id, String revision) {
    JSObject out = new JSObject();
    out.put("status", "saved");
    out.put("operationId", token);
    out.put("id", id);
    out.put("replaced", true);
    if (revision != null)
      out.put("revision", revision);
    return out;
  }
  private JSObject replaceResult(String token, JSONObject record) throws Exception {
    switch (record.optString("status")) {
      case "saved":
        return replaced(token, record.getString("id"), record.optString("revision", null));
      case "stale":
        return receipt("stale", token, null);
      case "writing": {
        String settled = settleReplace(token, record);
        if (settled.equals("saved"))
          return replaced(token, record.getString("id"), null);
        if (settled.equals("failed"))
          return receipt("failed", token, null);
        JSObject unknown = receipt("unknown", token, null);
        unknown.put("message", "Replacing the original was not confirmed. Inspect Photos.");
        return unknown;
      }
      default:
        if (!"failed".equals(record.optString("status"))) {
          record.put("status", "failed");
          if (!journal.edit().putString(token, record.toString()).commit())
            throw new IOException();
        }
        return receipt("failed", token, null);
    }
  }
  /** The original decoded upright in sRGB, reduced only above {@link #REPLACE_PIXELS}. */
  private static Bitmap decodeFull(byte[] snapshot) throws IOException {
    return ImageDecoder.decodeBitmap(
        ImageDecoder.createSource(java.nio.ByteBuffer.wrap(snapshot)), (decoder, info, src) -> {
          if (info.isAnimated())
            throw new IllegalArgumentException("Animated images cannot be edited here");
          int width = info.getSize().getWidth(), height = info.getSize().getHeight();
          double scale = Math.min(1d, Math.sqrt(REPLACE_PIXELS / ((double) width * height)));
          decoder.setTargetSize(Math.max(1, (int) Math.floor(width * scale)),
              Math.max(1, (int) Math.floor(height * scale)));
          decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
          decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB));
        });
  }
  /** The edited pixels encoded in the original's format in a private file. */
  @SuppressWarnings("deprecation")
  private File stage(Bitmap pixels, String mime, byte[] original) throws IOException {
    Bitmap.CompressFormat format = mime.equals("image/png") ? Bitmap.CompressFormat.PNG
        : mime.equals("image/webp")
        ? (Build.VERSION.SDK_INT >= 30 ? Bitmap.CompressFormat.WEBP_LOSSY
                                       : Bitmap.CompressFormat.WEBP)
        : Bitmap.CompressFormat.JPEG;
    File file = File.createTempFile("replace-", ".tmp", context.getCacheDir());
    try {
      try (FileOutputStream output = new FileOutputStream(file)) {
        if (!pixels.compress(format, format == Bitmap.CompressFormat.PNG ? 100 : 95, output))
          throw new IOException("Edited photo could not be encoded");
        output.getFD().sync();
      }
      if (format == Bitmap.CompressFormat.JPEG) {
        android.media.ExifInterface before =
            new android.media.ExifInterface(new ByteArrayInputStream(original));
        android.media.ExifInterface after =
            new android.media.ExifInterface(file.getAbsolutePath());
        for (String tag : KEPT_EXIF) {
          String value = before.getAttribute(tag);
          if (value != null)
            after.setAttribute(tag, value);
        }
        after.setAttribute(android.media.ExifInterface.TAG_ORIENTATION,
            Integer.toString(android.media.ExifInterface.ORIENTATION_NORMAL));
        after.saveAttributes();
      }
      return file;
    } catch (IOException | RuntimeException failure) {
      file.delete();
      throw failure;
    }
  }
  /**
   * The original's revision once MediaStore has rescanned the written file, waiting up to three
   * seconds; null when it has not changed by then (the bytes are written either way).
   */
  private String settled(Session s) {
    long until = SystemClock.elapsedRealtime() + 3000;
    while (true) {
      try {
        String now = revision(s.id);
        if (!now.equals(s.revision))
          return now;
      } catch (Exception rescanning) {
        // A permitted read refuses while the library generation moves; ask again.
      }
      if (SystemClock.elapsedRealtime() > until)
        return null;
      try {
        Thread.sleep(100);
      } catch (InterruptedException stopped) {
        Thread.currentThread().interrupt();
        return null;
      }
    }
  }
  public void cancel(String token) {
    Session s = active;
    if (s != null && (token == null || s.token.equals(token)))
      s.cancelled = true;
  }
  public void close() {
    Session s = active;
    active = null;
    if (s != null) {
      s.cancelled = true;
      if (s.pixels != null && !s.pixels.isRecycled())
        s.pixels.recycle();
    }
  }
  public void releaseCancelled() {
    Session s = active;
    if (s != null && s.cancelled)
      close();
  }
}
